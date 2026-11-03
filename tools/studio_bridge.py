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
import base64, contextlib, ftplib, glob, io, json, os, re, socket, sys, tempfile, threading, time, traceback

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
MASTER_FOLDER = "/SYSTEM/MASTER"         # outline fonts for Flash Font; the converter keeps its own in master/
MASTER_SUBDIR = "master"
LIST_LINE =re.compile(r"^([-dl])\S{9}\s+\d+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+(.+)$")


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


def master_info(path):
    import maxine_master as mm
    info = {"path": path, "file": os.path.basename(path), "size": os.path.getsize(path), "mtime": os.path.getmtime(path)}
    try:
        f = mm.load(path)
        info.update(name=f.name, id=f"{f.master_id:04d}", glyphs=len(f.glyphs), kern=len(f.kerning))
    except Exception:
        info.update(name="?", id=os.path.basename(path)[1:], glyphs=0, kern=0)
    return info


def outputs(args):
    res = [font_info(p) for p in glob.glob(os.path.join(glob.escape(args["dir"]), ".[0-9][0-9][0-9][0-9]"))]
    res.sort(key=lambda f: -f["mtime"])
    return res


def masters(args):
    res = [master_info(p) for p in glob.glob(os.path.join(glob.escape(args["dir"]), MASTER_SUBDIR, ".[0-9][0-9][0-9][0-9]"))]
    res.sort(key=lambda f: f["file"])
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
    res = {"font": font_info(path), "log": logs}
    if args.get("master"):
        import ttf2master
        mpath, _ = ttf2master.convert_master(args["ttf"], str(args["master_id"]), name=args.get("name") or None,
                                             out=os.path.join(args["out"], MASTER_SUBDIR), index=int(args.get("index", 0)),
                                             kern=bool(args["kern"]), preview=True, log=logs.append)
        res["master"] = master_info(mpath)
    return res


# ---- FTP.  The unit is a pSOS server ("UNIX Type: Chyron: pSOS").  It takes any login and
# refuses passive mode and has no SIZE, MDTM, FEAT or STAT, so every transfer is active mode:
# the unit connects back to this computer.  One control connection stays open from Connect
# to Disconnect and every command goes through it in turn: a burst of short sessions hung
# the unit once.
# Everything is paced for the same reason, and logged, because a hung unit can't be asked
# what happened.

MAX_MBIT = 10           # upload ceiling, whatever the setting says
FTP_TRACE = os.path.join(tempfile.gettempdir(), "MAXINE Studio", "ftp-trace.log")


def trace(text):
    try:
        os.makedirs(os.path.dirname(FTP_TRACE), exist_ok=True)
        with open(FTP_TRACE, "a") as fh:
            now = time.time()
            fh.write(f"{time.strftime('%H:%M:%S', time.localtime(now))}.{int(now * 1000) % 1000:03d} {text}\n")
    except OSError:
        pass


class PacedFTP(ftplib.FTP):
    """Waits `gap` seconds after each reply before the next command, and logs both."""
    gap = 0.0
    last_reply = 0.0

    def putcmd(self, line):
        wait = self.gap - (time.monotonic() - self.last_reply)
        if wait > 0:
            time.sleep(wait)
        trace("> " + line)
        super().putcmd(line)

    def getmultiline(self):
        line = super().getmultiline()
        self.last_reply = time.monotonic()
        trace("< " + line)
        return line


def command_gap(cfg):
    return max(float(cfg.get("gap") or 0), 0) / 1000


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
        trace(f"--- connect {where[0]}:{where[1]}")
        ftp = PacedFTP()
        ftp.gap = command_gap(cfg)
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

    def drop(self, why):
        """Hang up without a QUIT: after a failure the unit may not answer one."""
        trace(f"! {why}")
        ftp, self.ftp, self.where = self.ftp, None, None
        if ftp is not None:
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
                self.ftp.gap = command_gap(cfg)
                yield self.ftp
            except socket.timeout as e:
                self.drop("timed out")
                raise OSError("The unit stopped responding. It connects back to this computer for "
                              "every transfer, so check that a firewall isn't blocking it.") from e
            except (OSError, EOFError, ftplib.error_temp) as e:
                self.drop(f"{type(e).__name__}: {e}")
                raise


LINK = FtpLink()


def parse_list_line(line):
    m = LIST_LINE.match(line)
    return {"name": m[3], "size": int(m[2]), "dir": m[1] == "d"} if m else None


def folder_entries(ftp):
    lines = []
    ftp.retrlines("LIST", lines.append)
    entries = [e for e in map(parse_list_line, lines) if e]
    entries.sort(key=lambda e: (not FONT_FILE.match(e["name"]), e["name"]))
    return entries


def listing(ftp):
    """The font folder and the master folder, with the connection left in the font folder."""
    entries = folder_entries(ftp)
    try:
        ftp.cwd(MASTER_FOLDER)
        masters = folder_entries(ftp)
    except ftplib.error_perm:
        masters = []
    finally:
        ftp.cwd(FONT_FOLDER)
    return {"welcome": ftp.getwelcome(), "cwd": LINK.cwd, "entries": entries, "masters": masters}


def ftp_list(args):
    with LINK.session(args) as ftp:
        return listing(ftp)


def ftp_upload(args):
    """Upload a batch, stopping at the first failure so the unit is never left guessing.
    Sizes are checked from one listing at the end: it's the only way to read a length back.
    The unit locks up partway through batches, so data goes out at `speed` Mbit/s at most,
    in 1 KB writes to keep bursts small, and `pause` seconds go by after each file, with a
    countdown for the UI."""
    done = []
    masters_done = []
    pause = float(args.get("pause") or 0)
    rate = min(float(args.get("speed") or MAX_MBIT), MAX_MBIT) * 1e6 / 8     # bytes per second

    def store(ftp, p):
        name = os.path.basename(p); total = os.path.getsize(p); sent = 0
        started = time.monotonic()
        def progress(block):
            nonlocal sent
            sent += len(block)
            if sent % 8192 == 0 or sent == total:
                send({"event": "upload", "name": name, "sent": sent, "total": total})
            if sent % 65536 == 0 or sent == total:
                trace(f"  {name}: {sent} of {total} bytes written")
            wait = started + sent / rate - time.monotonic()
            if wait > 0:
                time.sleep(wait)
        with open(p, "rb") as fh:
            ftp.storbinary("STOR " + name, fh, 1024, progress)
        left = pause
        while left > 0:
            send({"event": "upload", "name": name, "sent": total, "total": total, "wait": round(left)})
            time.sleep(min(left, 1)); left -= 1
        return {"name": name, "size": total}

    with LINK.session(args) as ftp:
        for p in args["paths"]:
            done.append(store(ftp, p))
        if args.get("masters"):
            ftp.cwd(MASTER_FOLDER)
            try:
                for p in args["masters"]:
                    masters_done.append(store(ftp, p))
            finally:
                ftp.cwd(FONT_FOLDER)
        after = listing(ftp)
    short = []
    for sent_list, entries in ((done, after["entries"]), (masters_done, after["masters"])):
        sizes = {e["name"]: e["size"] for e in entries}
        short += [f"{d['name']} ({sizes.get(d['name'])} of {d['size']} bytes)" for d in sent_list if sizes.get(d["name"]) != d["size"]]
    if short:
        raise IOError("The unit has the wrong size for " + ", ".join(short) + ". Don't load them.")
    return {"done": done, "masters": masters_done, "listing": after}


def ftp_delete(args):
    """Delete a batch of 9xxx files, `items` being [{"name", "master"}], each in its folder,
    paced like every other command."""
    items = args["items"]
    bad = [i["name"] for i in items if not TEST_FONT.match(i["name"])]
    if bad:      # never touch the unit's original fonts
        raise ValueError("Only 9xxx test fonts can be deleted from the unit: " + ", ".join(bad))
    with LINK.session(args) as ftp:
        for folder, master in ((FONT_FOLDER, False), (MASTER_FOLDER, True)):
            names = [i["name"] for i in items if bool(i.get("master")) == master]
            if not names:
                continue
            if master:
                ftp.cwd(folder)
            try:
                for name in names:
                    ftp.delete(name)
            finally:
                if master:
                    ftp.cwd(FONT_FOLDER)
        return listing(ftp)


def ftp_disconnect(args):
    with LINK.lock:
        LINK.close()
    return True


COMMANDS = {"system_fonts": system_fonts, "faces": faces, "outputs": outputs, "masters": masters, "source_preview": source_preview, "convert": convert,
            "ftp_list": ftp_list, "ftp_upload": ftp_upload, "ftp_delete": ftp_delete, "ftp_disconnect": ftp_disconnect}


def handle(req):
    try:
        send({"id": req["id"], "ok": True, "result": COMMANDS[req["cmd"]](req.get("args") or {})})
    except Exception as e:
        traceback.print_exc()
        send({"id": req["id"], "ok": False, "error": str(e) or type(e).__name__})


def preload():
    """The first load after an install is slow while the system checks numpy's and Pillow's native
    libraries, so that happens during the font scan, not on the first preview."""
    import ttf2maxine


def main():
    threading.Thread(target=preload, daemon=True).start()
    send({"event": "ready"})
    for line in sys.stdin:
        if line.strip():
            threading.Thread(target=handle, args=(json.loads(line),), daemon=True).start()
    ftp_disconnect({})      # a QUIT on the way out, not a dropped socket


if __name__ == "__main__":
    main()
