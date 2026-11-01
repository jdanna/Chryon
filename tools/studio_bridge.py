#!/usr/bin/env python3
"""
JSON-lines backend for the MAXINE! Studio Electron app (src/main/bridge.ts).

    stdin:  {"id": 1, "cmd": "convert", "args": {...}}
    stdout: {"id": 1, "ok": true, "result": ...}  or  {"id": 1, "ok": false, "error": "..."}
            {"event": "upload", ...}              progress, not tied to a reply

Every request runs on its own thread, so a font scan or an FTP transfer never
blocks a conversion.  The process exits when stdin closes (the app went away).
The converter needs Pillow, numpy and fontTools; FTP uses only the stdlib.
"""
import base64, contextlib, ftplib, glob, io, json, os, re, socket, sys, threading, time, traceback

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

# stdout is the protocol: a stray print() from a library must not land in it
_out = sys.stdout
sys.stdout = sys.stderr
_out_lock = threading.Lock()

FONT_DIRS = ["/System/Library/Fonts", "/Library/Fonts", os.path.expanduser("~/Library/Fonts"),
             "/usr/share/fonts", "/usr/local/share/fonts", os.path.expanduser("~/.fonts"),
             os.path.expanduser("~/.local/share/fonts"), "C:/Windows/Fonts",
             os.path.join(os.environ.get("LOCALAPPDATA", ""), "Microsoft/Windows/Fonts")]
FONT_FILE = re.compile(r"^\.\d{4}$")     # the only names the MAXINE recognizes
TEST_FONT = re.compile(r"^\.9\d{3}$")    # synthetic codes, the only fonts this app will delete

FONT_FOLDER = "/MAXINE/MACHINE"
LIST_LINE = re.compile(r"^([-dl])\S{9}\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+(.+)$")


def send(obj):
    with _out_lock:
        _out.write(json.dumps(obj) + "\n")
        _out.flush()


def face_names(path):
    """Names of all faces in a font file (1 for ttf/otf, several for ttc)."""
    from fontTools.ttLib import TTFont, TTCollection
    names = []
    try:
        if path.lower().endswith(".ttc"):
            coll = TTCollection(path, lazy=True)
            for f in coll.fonts:
                names.append(f["name"].getDebugName(4) or os.path.basename(path))
        else:
            names.append(TTFont(path, lazy=True)["name"].getDebugName(4) or os.path.basename(path))
    except Exception:
        names = [os.path.basename(path)]
    return names


def system_fonts(args):
    out = []
    seen = set()
    for d in FONT_DIRS:
        for root, _, files in os.walk(d):
            for fn in sorted(files):
                p = os.path.join(root, fn)
                if not fn.lower().endswith((".ttf", ".otf", ".ttc")) or p in seen:
                    continue
                seen.add(p)
                for i, n in enumerate(face_names(p)):
                    if n.startswith("."):      # macOS internal/hidden faces
                        continue
                    out.append({"path": p, "index": i, "name": n})
    out.sort(key=lambda f: f["name"].lower())
    return out


def faces(args):
    return face_names(args["path"])


def font_info(path):
    import maxine_font as mx
    info = {"path": path, "file": os.path.basename(path), "size": os.path.getsize(path),
            "mtime": os.path.getmtime(path), "preview": os.path.exists(path + ".png")}
    try:
        f = mx.load(path)
        info.update(name=f.name, desc=(f.desc1 + " " + f.desc2).strip(), master=f.digits[:4], glyphs=len(f.glyphs), kern=len(f.kerning),
                    cell_rows=f.cell_rows, ascent=f.ascent, descent=f.descent, baseline_row=f.baseline_row)
    except Exception:
        info.update(name="?", desc="unreadable")
    return info


def outputs(args):
    res = [font_info(p) for p in glob.glob(os.path.join(glob.escape(args["dir"]), ".[0-9][0-9][0-9][0-9]"))]
    res.sort(key=lambda f: -f["mtime"])
    return res


def source_preview(args):
    import ttf2maxine
    png = io.BytesIO()
    ascii_count, letters = ttf2maxine.source_sheet(args["ttf"], png, int(args["scanlines"]), float(args["aspect"]), float(args["spacing"]),
                                                   bool(args["kern"]), args["edge"], int(args["lines"]), int(args.get("index", 0)))
    return {"image": base64.b64encode(png.getvalue()).decode(), "ascii": ascii_count, "letters": letters}


def convert(args):
    import maxine_font as mx, ttf2maxine
    logs = []
    path, _ = ttf2maxine.convert(
        args["ttf"], scanlines=int(args["scanlines"]), code=str(args["code"]), master_id=str(args["master_id"]),
        name=args.get("name") or None, edge=args["edge"], lines=int(args["lines"]), aspect=float(args["aspect"]),
        spacing=float(args["spacing"]), kern=bool(args["kern"]), out=args["out"],
        index=int(args.get("index", 0)), log=logs.append)
    font = mx.load(path)
    mx.render_sheet(font, path + ".png", lines=ttf2maxine.specimen(lambda c: ord(c) in font.glyphs))
    ttf2maxine.source_sheet(args["ttf"], path + ".source.png", int(args["scanlines"]), float(args["aspect"]),
                            float(args["spacing"]), index=int(args.get("index", 0)), font=font)
    return {"font": font_info(path), "log": logs}


# ---- FTP.  The unit is a pSOS server ("UNIX Type: Chyron: pSOS").  It takes any login and
# has no PASV, SIZE, MDTM, FEAT or STAT, so every transfer is active mode: the unit connects
# back to this computer.  One control connection stays open from Connect to Disconnect and
# every command goes through it in turn: a burst of short sessions hung the unit once.

class FtpLink:
    def __init__(self):
        self.ftp = None
        self.where = None
        self.cwd = ""
        self.lock = threading.Lock()

    def open(self, cfg):
        host = (cfg.get("host") or "").strip()
        if not host:
            raise ValueError("Enter the MAXINE!'s FTP host or IP address.")
        where = (host, int(cfg.get("port") or 21))
        self.close()
        ftp = ftplib.FTP()
        ftp.connect(*where, timeout=20)
        try:
            ftp.login()
            ftp.set_pasv(False)
            ftp.cwd(FONT_FOLDER)
            cwd = ftp.pwd()
        except BaseException:
            ftp.close()
            raise
        self.ftp, self.where, self.cwd = ftp, where, cwd

    def close(self):
        ftp, self.ftp, self.where = self.ftp, None, None
        if ftp is not None:
            try:
                ftp.quit()
            except ftplib.all_errors:
                ftp.close()

    def alive(self):
        """A NOOP on the control connection, in case the unit was restarted since the last command."""
        try:
            return self.ftp.voidcmd("NOOP").startswith("200")
        except ftplib.all_errors:      # includes OSError and EOFError
            return False

    @contextlib.contextmanager
    def session(self, cfg):
        """The open connection, reconnected if the host changed or the unit dropped it."""
        with self.lock:
            try:
                if self.ftp is None or self.where != ((cfg.get("host") or "").strip(), int(cfg.get("port") or 21)) or not self.alive():
                    self.open(cfg)
                yield self.ftp
            except socket.timeout as e:
                self.close()
                raise OSError("The unit stopped responding. It connects back to this computer for "
                              "every transfer, so check that a firewall isn't blocking it.") from e
            except (OSError, EOFError, ftplib.error_temp):
                self.close()
                raise


LINK = FtpLink()


def parse_list_line(line):
    m = LIST_LINE.match(line)
    return {"name": m[3], "size": int(m[2]), "dir": m[1] == "d"} if m else None


def listing(ftp):
    lines = []
    ftp.retrlines("LIST", lines.append)
    entries = [e for e in map(parse_list_line, lines) if e]
    entries.sort(key=lambda e: (not FONT_FILE.match(e["name"]), e["name"]))
    return {"welcome": ftp.getwelcome(), "cwd": LINK.cwd, "entries": entries}


def ftp_list(args):
    with LINK.session(args) as ftp:
        return listing(ftp)


def ftp_upload(args):
    """Upload a batch, stopping at the first failure so the unit is never left guessing.
    Sizes are checked from one listing at the end: it's the only way to read a length back.
    Every transfer is a data connection the unit has to tear down, and it locked up after
    three in quick succession even on one control connection, so `pause` seconds go by
    after each file before the next connection, with a countdown for the UI."""
    done = []
    pause = float(args.get("pause") or 0)
    with LINK.session(args) as ftp:
        for i, p in enumerate(args["paths"]):
            name = os.path.basename(p); total = os.path.getsize(p); sent = 0
            def progress(block):
                nonlocal sent
                sent += len(block)
                send({"event": "upload", "name": name, "sent": sent, "total": total})
            with open(p, "rb") as fh:
                ftp.storbinary("STOR " + name, fh, callback=progress)
            done.append({"name": name, "size": total})
            left = pause
            while left > 0:
                send({"event": "upload", "name": name, "sent": total, "total": total, "wait": round(left)})
                time.sleep(min(left, 1)); left -= 1
        after = listing(ftp)
    sizes = {e["name"]: e["size"] for e in after["entries"]}
    short = [f"{d['name']} ({sizes.get(d['name'])} of {d['size']} bytes)" for d in done if sizes.get(d["name"]) != d["size"]]
    if short:
        raise IOError("The unit has the wrong size for " + ", ".join(short) + ". Don't load them.")
    return {"done": done, "listing": after}


def ftp_delete(args):
    name = args["name"]
    if not TEST_FONT.match(name):      # never touch the unit's original fonts
        raise ValueError("Only 9xxx test fonts can be deleted from the unit: " + name)
    with LINK.session(args) as ftp:
        ftp.delete(name)
        return listing(ftp)


def ftp_disconnect(args):
    with LINK.lock:
        LINK.close()
    return True


COMMANDS = {"system_fonts": system_fonts, "faces": faces, "outputs": outputs, "source_preview": source_preview, "convert": convert,
            "ftp_list": ftp_list, "ftp_upload": ftp_upload, "ftp_delete": ftp_delete, "ftp_disconnect": ftp_disconnect}


def handle(req):
    try:
        send({"id": req["id"], "ok": True, "result": COMMANDS[req["cmd"]](req.get("args") or {})})
    except Exception as e:
        traceback.print_exc()
        send({"id": req["id"], "ok": False, "error": str(e) or type(e).__name__})


def main():
    send({"event": "ready"})
    for line in sys.stdin:
        if line.strip():
            threading.Thread(target=handle, args=(json.loads(line),), daemon=True).start()
    ftp_disconnect({})      # a QUIT on the way out, not a dropped socket


if __name__ == "__main__":
    main()
