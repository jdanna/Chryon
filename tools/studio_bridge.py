#!/usr/bin/env python3
"""
JSON-lines backend for the MAXINE Font Studio Electron app (src/main/bridge.ts).

    stdin:  {"id": 1, "cmd": "convert", "args": {...}}
    stdout: {"id": 1, "ok": true, "result": ...}  or  {"id": 1, "ok": false, "error": "..."}
            {"event": "upload", ...}              progress, not tied to a reply

Every request runs on its own thread, so a font scan or an FTP transfer never
blocks a conversion.  The process exits when stdin closes (the app went away).
The converter needs Pillow, numpy and fontTools; FTP uses only the stdlib.
"""
import ftplib, glob, json, os, re, sys, threading, traceback

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

UNIX_LIST = re.compile(r"^([-dl])\S{9}\S*\s+\d+\s+\S+(?:\s+\S+)?\s+(\d+)\s+(\S+\s+\S+\s+\S+)\s+(.+)$")
DOS_LIST = re.compile(r"^(\d\d-\d\d-\d\d(?:\d\d)?\s+\d\d:\d\d[AP]M)\s+(<DIR>|\d+)\s+(.+)$", re.I)


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
        info.update(name=f.name, desc=(f.desc1 + " " + f.desc2).strip(), glyphs=len(f.glyphs), kern=len(f.kerning),
                    cell_rows=f.cell_rows, ascent=f.ascent, descent=f.descent, baseline_row=f.baseline_row)
    except Exception:
        info.update(name="?", desc="unreadable")
    return info


def outputs(args):
    res = [font_info(p) for p in glob.glob(os.path.join(glob.escape(args["dir"]), ".[0-9][0-9][0-9][0-9]"))]
    res.sort(key=lambda f: -f["mtime"])
    return res


def convert(args):
    import ttf2maxine
    logs = []
    path, png = ttf2maxine.convert(
        args["ttf"], scanlines=int(args["scanlines"]), code=str(args["code"]), master_id=str(args["master_id"]),
        name=args.get("name") or None, edge=args["edge"], lines=int(args["lines"]), aspect=float(args["aspect"]),
        spacing=float(args["spacing"]), kern=bool(args["kern"]), out=args["out"], preview=True,
        index=int(args.get("index", 0)), log=logs.append)
    return {"font": font_info(path), "log": logs}


# ---- FTP.  Each command is its own short session: nothing here has been tried on
# the real unit, and a held-open connection is one more thing for old firmware to trip on.

def ftp_connect(cfg):
    host = (cfg.get("host") or "").strip()
    if not host:
        raise ValueError("Enter the MAXINE's FTP host or IP address.")
    ftp = ftplib.FTP()
    ftp.connect(host, int(cfg.get("port") or 21), timeout=20)
    ftp.login(cfg.get("user") or "anonymous", cfg.get("password") or "")
    ftp.set_pasv(bool(cfg.get("passive", True)))
    d = (cfg.get("dir") or "").strip()
    if d:
        ftp.cwd(d)
    return ftp


def parse_list_line(line):
    m = UNIX_LIST.match(line)
    if m:
        return {"name": m[4], "size": int(m[2]), "date": m[3], "dir": m[1] == "d"}
    m = DOS_LIST.match(line)
    if m:
        is_dir = m[2].upper() == "<DIR>"
        return {"name": m[3], "size": None if is_dir else int(m[2]), "date": m[1], "dir": is_dir}
    return {"name": line.split()[-1], "size": None, "date": "", "dir": False} if line.strip() else None


def ftp_list_entries(ftp):
    # The fonts are dotfiles, which a plain LIST hides on most Unix-style servers.
    # `LIST -a` isn't standard (some servers read -a as a path), so fall back in steps.
    lines = []
    try:
        ftp.retrlines("LIST -a", lines.append)
    except ftplib.all_errors:
        lines = []
    if not lines:
        try:
            ftp.retrlines("LIST", lines.append)
        except ftplib.all_errors:
            lines = ftp.nlst()
    entries = [e for e in map(parse_list_line, lines) if e and e["name"] not in (".", "..")]
    entries.sort(key=lambda e: (not FONT_FILE.match(e["name"]), e["name"]))
    return entries


def ftp_list(args):
    ftp = ftp_connect(args)
    try:
        return {"welcome": ftp.getwelcome(), "cwd": ftp.pwd(), "entries": ftp_list_entries(ftp)}
    finally:
        ftp.quit()


def ftp_upload(args):
    """Upload a batch, stopping at the first failure so the unit is never left guessing."""
    ftp = ftp_connect(args)
    done = []
    try:
        for p in args["paths"]:
            name = os.path.basename(p); total = os.path.getsize(p); sent = 0
            def progress(block):
                nonlocal sent
                sent += len(block)
                send({"event": "upload", "name": name, "sent": sent, "total": total})
            with open(p, "rb") as fh:
                ftp.storbinary("STOR " + name, fh, callback=progress)
            try:
                remote = ftp.size(name)
            except ftplib.all_errors:
                remote = None
            if remote is not None and remote != total:
                raise IOError(f"{name}: unit reports {remote} bytes, expected {total}")
            done.append({"name": name, "local_size": total, "remote_size": remote})
    finally:
        ftp.quit()
    return done


def ftp_delete(args):
    name = args["name"]
    if not TEST_FONT.match(name):      # never touch the unit's original fonts
        raise ValueError("Only 9xxx test fonts can be deleted from the unit: " + name)
    ftp = ftp_connect(args)
    try:
        ftp.delete(name)
    finally:
        ftp.quit()
    return True


COMMANDS = {"system_fonts": system_fonts, "faces": faces, "outputs": outputs, "convert": convert,
            "ftp_list": ftp_list, "ftp_upload": ftp_upload, "ftp_delete": ftp_delete}


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


if __name__ == "__main__":
    main()
