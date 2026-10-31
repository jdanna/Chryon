#!/usr/bin/env python3
"""
MAXINE Font Studio — a local web app to convert TTF/OTF fonts into Chyron
MAXINE machine fonts, preview them, and upload them to the unit over FTP.

    python3 tools/maxine_studio.py            # opens http://127.0.0.1:8765 in your browser
    python3 tools/maxine_studio.py --port 9000 --no-browser

Only Python's standard library is used for the server; the converter needs
Pillow, numpy and fontTools.  The server binds to localhost only.

Converter output is NOT yet hardware-validated: load one file at a time on
the MAXINE and stop if it fails to load, hangs or crashes.
"""
import os, sys, json, glob, ftplib, argparse, threading, webbrowser, traceback, urllib.parse, io, re
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import ttf2maxine
import maxine_font as mx

ROOT = os.path.dirname(HERE)
DEFAULT_OUT = os.path.join(ROOT, "experiments")
UPLOAD_DIR = os.path.join(ROOT, "experiments", "uploaded-fonts")
FONT_DIRS = ["/System/Library/Fonts", "/System/Library/Fonts/Supplemental", "/Library/Fonts",
             os.path.expanduser("~/Library/Fonts"), "/usr/share/fonts", "/usr/local/share/fonts",
             os.path.expanduser("~/.fonts"), "C:/Windows/Fonts"]

_font_cache = None
_lock = threading.Lock()


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


def system_fonts():
    global _font_cache
    with _lock:
        if _font_cache is not None:
            return _font_cache
        out = []
        seen = set()
        for d in FONT_DIRS:
            if not os.path.isdir(d):
                continue
            for p in sorted(glob.glob(os.path.join(d, "*"))):
                if not p.lower().endswith((".ttf", ".otf", ".ttc")) or p in seen:
                    continue
                seen.add(p)
                for i, n in enumerate(face_names(p)):
                    if n.startswith("."):      # macOS internal/hidden faces
                        continue
                    out.append({"path": p, "index": i, "name": n})
        out.sort(key=lambda f: f["name"].lower())
        _font_cache = out
        return out


def list_outputs(out_dir):
    res = []
    for p in sorted(glob.glob(os.path.join(out_dir, ".[0-9][0-9][0-9][0-9]"))):
        try:
            f = mx.load(p)
            res.append({"path": p, "file": os.path.basename(p), "name": f.name, "desc": (f.desc1 + " " + f.desc2).strip(),
                        "size": os.path.getsize(p), "preview": os.path.exists(p + ".png"), "mtime": os.path.getmtime(p)})
        except Exception:
            res.append({"path": p, "file": os.path.basename(p), "name": "?", "desc": "unreadable", "size": os.path.getsize(p), "preview": False, "mtime": os.path.getmtime(p)})
    res.sort(key=lambda f: -f["mtime"])
    return res


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


class Handler(BaseHTTPRequestHandler):
    server_version = "MaxineStudio/1.0"

    def log_message(self, fmt, *args):  # quieter console
        if self.server.verbose:
            super().log_message(fmt, *args)

    # ---- helpers
    def _json(self, obj, status=200):
        b = json.dumps(obj).encode()
        self.send_response(status); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(b))); self.end_headers()
        self.wfile.write(b)

    def _bytes(self, b, ctype, status=200):
        self.send_response(status); self.send_header("Content-Type", ctype); self.send_header("Content-Length", str(len(b))); self.end_headers()
        self.wfile.write(b)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def _safe_path(self, p):
        """Only serve/accept files under the repo, the uploads dir, the chosen output dir or system font dirs."""
        p = os.path.abspath(p)
        roots = [ROOT, UPLOAD_DIR, os.path.abspath(self.server.out_dir)] + [os.path.abspath(d) for d in FONT_DIRS]
        if not any(p == r or p.startswith(r + os.sep) for r in roots):
            raise PermissionError("path not allowed: " + p)
        return p

    # ---- GET
    def do_GET(self):
        u = urllib.parse.urlparse(self.path); q = urllib.parse.parse_qs(u.query)
        try:
            if u.path == "/":
                self._bytes(PAGE.encode(), "text/html; charset=utf-8")
            elif u.path == "/api/system-fonts":
                self._json(system_fonts())
            elif u.path == "/api/outputs":
                self._json({"out": self.server.out_dir, "files": list_outputs(self.server.out_dir)})
            elif u.path == "/api/faces":
                self._json(face_names(self._safe_path(q["path"][0])))
            elif u.path == "/api/preview":
                p = self._safe_path(q["path"][0])
                self._bytes(open(p, "rb").read(), "image/png")
            elif u.path == "/api/download":
                p = self._safe_path(q["path"][0])
                b = open(p, "rb").read()
                self.send_response(200); self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Disposition", f'attachment; filename="{os.path.basename(p)}"')
                self.send_header("Content-Length", str(len(b))); self.end_headers(); self.wfile.write(b)
            else:
                self._json({"error": "not found"}, 404)
        except Exception as e:
            self._json({"error": str(e), "trace": traceback.format_exc()}, 500)

    # ---- POST / PUT
    def do_PUT(self):
        try:
            if self.path.startswith("/api/upload"):
                name = urllib.parse.unquote(self.headers.get("X-Filename") or "font.ttf")
                name = re.sub(r"[^A-Za-z0-9._ -]", "_", os.path.basename(name))
                os.makedirs(UPLOAD_DIR, exist_ok=True)
                p = os.path.join(UPLOAD_DIR, name)
                open(p, "wb").write(self._body())
                self._json({"path": p, "faces": face_names(p)})
            else:
                self._json({"error": "not found"}, 404)
        except Exception as e:
            self._json({"error": str(e), "trace": traceback.format_exc()}, 500)

    def do_POST(self):
        try:
            data = json.loads(self._body() or b"{}")
            if self.path == "/api/convert":
                logs = []
                ttf = self._safe_path(data["ttf"])
                out = data.get("out") or self.server.out_dir
                path, png = ttf2maxine.convert(
                    ttf, scanlines=int(data.get("scanlines", 46)), code=str(data.get("code", "9100")),
                    master_id=str(data.get("master_id", "9000")), name=(data.get("name") or None),
                    edge=data.get("edge", "none"), lines=int(data.get("lines", 3)),
                    aspect=float(data.get("aspect", 1.17)), spacing=float(data.get("spacing", 0.95)),
                    baseline_off=(int(data["baseline_off"]) if data.get("baseline_off") not in (None, "") else None),
                    chars=(data.get("chars") or None), kern=bool(data.get("kern", True)), out=out,
                    preview=True, index=int(data.get("index", 0)), log=logs.append)
                f = mx.load(path)
                self._json({"path": path, "png": png, "size": os.path.getsize(path), "glyphs": len(f.glyphs),
                            "kern": len(f.kerning), "cell_rows": f.cell_rows, "ascent": f.ascent, "descent": f.descent,
                            "baseline_row": f.baseline_row, "log": logs})
            elif self.path == "/api/ftp/list":
                ftp = ftp_connect(data)
                lines = []
                welcome = ftp.getwelcome(); cwd = ftp.pwd()
                try:
                    ftp.retrlines("LIST", lines.append)
                except ftplib.all_errors:
                    lines = ftp.nlst()
                ftp.quit()
                self._json({"welcome": welcome, "cwd": cwd, "entries": lines})
            elif self.path == "/api/ftp/upload":
                p = self._safe_path(data["path"]); name = data.get("remote_name") or os.path.basename(p)
                ftp = ftp_connect(data)
                with open(p, "rb") as fh:
                    ftp.storbinary("STOR " + name, fh)
                try:
                    size = ftp.size(name)
                except ftplib.all_errors:
                    size = None
                ftp.quit()
                self._json({"ok": True, "remote_name": name, "remote_size": size, "local_size": os.path.getsize(p)})
            else:
                self._json({"error": "not found"}, 404)
        except Exception as e:
            self._json({"error": str(e), "trace": traceback.format_exc()}, 500)


PAGE = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MAXINE Font Studio</title>
<style>
:root{--bg:#0f1115;--panel:#171a21;--panel2:#1d2129;--line:#262b36;--text:#e6e8ee;--muted:#8b93a7;--accent:#5ab0ff;--accent2:#ff5a5a;--ok:#4ad67a;--warn:#ffb454;--radius:14px}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,Helvetica,Arial,sans-serif}
header{display:flex;align-items:center;gap:14px;padding:14px 22px;border-bottom:1px solid var(--line);background:linear-gradient(180deg,#141720,#0f1115)}
header h1{font-size:17px;margin:0;letter-spacing:.3px;font-weight:650}
header .badge{font-size:11px;color:#1b1d22;background:var(--warn);padding:3px 9px;border-radius:999px;font-weight:650}
header .spacer{flex:1}
header .status{color:var(--muted);font-size:13px}
main{display:grid;grid-template-columns:400px 1fr;gap:18px;padding:18px 22px;min-height:calc(100vh - 56px)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:16px 18px;margin-bottom:16px}
.card h2{margin:0 0 12px;font-size:13px;text-transform:uppercase;letter-spacing:1.2px;color:var(--muted);font-weight:650}
label{display:block;font-size:12px;color:var(--muted);margin:10px 0 4px}
input[type=text],input[type=number],input[type=password],select,textarea{width:100%;background:var(--panel2);border:1px solid var(--line);color:var(--text);border-radius:9px;padding:8px 10px;font:inherit;outline:none}
input:focus,select:focus{border-color:var(--accent)}
.row{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.row3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px}
.check{display:flex;align-items:center;gap:8px;margin-top:10px;color:var(--text);font-size:13px}
.check input{accent-color:var(--accent)}
button{background:var(--accent);color:#0b1220;border:0;border-radius:10px;padding:10px 14px;font:inherit;font-weight:650;cursor:pointer}
button.secondary{background:var(--panel2);color:var(--text);border:1px solid var(--line)}
button.danger{background:var(--accent2);color:#fff}
button:disabled{opacity:.45;cursor:default}
.btnrow{display:flex;gap:8px;margin-top:14px;flex-wrap:wrap}
.drop{border:1.5px dashed #343a48;border-radius:12px;padding:14px;text-align:center;color:var(--muted);font-size:12.5px;margin-top:10px;transition:.15s}
.drop.over{border-color:var(--accent);color:var(--accent);background:#14202e}
.preview{background:#1e1e1e;border-radius:12px;min-height:420px;display:flex;align-items:center;justify-content:center;overflow:auto;border:1px solid var(--line)}
.preview img{image-rendering:auto;max-width:100%;}
.preview .empty{color:var(--muted);padding:40px;text-align:center}
.stats{display:flex;gap:18px;flex-wrap:wrap;color:var(--muted);font-size:12.5px;margin-top:10px}
.stats b{color:var(--text);font-weight:600}
.log{background:#0b0d12;border:1px solid var(--line);border-radius:10px;padding:10px 12px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#b9c0d0;height:170px;overflow:auto;white-space:pre-wrap}
.log .err{color:#ff8080}.log .ok{color:var(--ok)}
.files{width:100%;border-collapse:collapse;font-size:12.5px}
.files td,.files th{padding:7px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:middle}
.files th{color:var(--muted);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.8px}
.files tr:hover td{background:#1b1f28}
.files button{padding:5px 9px;font-size:12px;border-radius:7px}
.hint{color:var(--muted);font-size:12px;margin-top:6px}
.spin{display:inline-block;width:12px;height:12px;border:2px solid #0b1220;border-right-color:transparent;border-radius:50%;animation:s .7s linear infinite;vertical-align:-2px;margin-right:6px}
@keyframes s{to{transform:rotate(360deg)}}
.tag{display:inline-block;padding:2px 7px;border-radius:999px;background:var(--panel2);border:1px solid var(--line);font-size:11px;color:var(--muted)}
@media (max-width:980px){main{grid-template-columns:1fr}}
</style></head>
<body>
<header>
  <h1>MAXINE Font Studio</h1>
  <span class="badge">UNTESTED ON HARDWARE</span>
  <span class="spacer"></span>
  <span class="status" id="status">Ready</span>
</header>
<main>
<div>
  <div class="card">
    <h2>1 · Source font</h2>
    <label>Installed fonts</label>
    <input type="text" id="search" placeholder="Type to filter…">
    <select id="sysfont" size="7" style="margin-top:6px;font-size:13px"></select>
    <div class="drop" id="drop">…or drop a .ttf / .otf / .ttc here, or <u style="cursor:pointer" id="pick">choose a file</u><input type="file" id="file" accept=".ttf,.otf,.ttc" hidden></div>
    <div class="hint" id="chosen">Nothing selected.</div>
    <label>Face (for .ttc collections)</label>
    <select id="face"></select>
  </div>
  <div class="card">
    <h2>2 · Conversion settings</h2>
    <label>Display name (shown in the MAXINE font browser)</label>
    <input type="text" id="name" maxlength="59">
    <div class="row3">
      <div><label>Scanlines</label><input type="number" id="scanlines" value="46" min="10" max="200"></div>
      <div><label>Font code</label><input type="text" id="code" value="9100" maxlength="4" pattern="\d{4}"></div>
      <div><label>Master id</label><input type="text" id="master_id" value="9000" maxlength="4"></div>
    </div>
    <div class="row">
      <div><label>Edge</label><select id="edge"><option value="none">No edge</option><option value="border">Border</option><option value="shadow">Border &amp; shadow (lower left)</option></select></div>
      <div><label>Edge lines</label><input type="number" id="lines" value="3" min="1" max="10"></div>
    </div>
    <div class="row">
      <div><label>Pixel aspect (x/y)</label><input type="number" id="aspect" value="1.17" step="0.01"></div>
      <div><label>Spacing factor</label><input type="number" id="spacing" value="0.95" step="0.01"></div>
    </div>
    <label class="check"><input type="checkbox" id="kern" checked> Copy pair kerning from the font</label>
    <label>Output folder</label>
    <input type="text" id="out">
    <div class="btnrow"><button id="convert">Convert &amp; preview</button></div>
    <div class="hint">The file is named <span class="tag" id="outname">.9100</span> — the 4-digit dotfile name the MAXINE expects. Use 9xxx codes for tests so nothing collides with real fonts.</div>
  </div>
  <div class="card">
    <h2>3 · Upload to the MAXINE (FTP)</h2>
    <div class="row"><div><label>Host / IP</label><input type="text" id="ftp_host" placeholder="192.168.1.50"></div><div><label>Port</label><input type="number" id="ftp_port" value="21"></div></div>
    <div class="row"><div><label>User</label><input type="text" id="ftp_user" value="anonymous"></div><div><label>Password</label><input type="password" id="ftp_pass"></div></div>
    <label>Remote folder (where the fonts live)</label><input type="text" id="ftp_dir" placeholder="/">
    <label class="check"><input type="checkbox" id="ftp_passive" checked> Passive mode (untick if the old server only does active)</label>
    <label class="check"><input type="checkbox" id="ftp_remember"> Remember password in this browser</label>
    <div class="btnrow"><button class="secondary" id="ftp_test">Test &amp; list remote folder</button><button id="ftp_upload" disabled>Upload converted font</button></div>
    <div class="hint">Load one font at a time on the unit. If it fails to load, hangs or crashes, stop and note which file.</div>
  </div>
</div>
<div>
  <div class="card">
    <h2>Preview — rendered from the finished .NNNN file by our own decoder</h2>
    <div class="preview" id="preview"><div class="empty">Convert a font to see what the MAXINE should display.<br><small>Face in white, border/shadow layer in red.</small></div></div>
    <div class="stats" id="stats"></div>
    <div class="btnrow"><button class="secondary" id="download" disabled>Download .NNNN</button><button class="secondary" id="openpng" disabled>Open preview PNG</button></div>
  </div>
  <div class="card">
    <h2>Log</h2>
    <div class="log" id="log"></div>
  </div>
  <div class="card">
    <h2>Converted fonts in the output folder</h2>
    <table class="files" id="files"><thead><tr><th>File</th><th>Name</th><th>Description</th><th>Size</th><th></th></tr></thead><tbody></tbody></table>
  </div>
</div>
</main>
<script>
const $=id=>document.getElementById(id);
const S={ttf:null,index:0,last:null};
const settingsKeys=['scanlines','code','master_id','edge','lines','aspect','spacing','kern','out','ftp_host','ftp_port','ftp_user','ftp_dir','ftp_passive','ftp_remember','ftp_pass'];
function log(m,cls){const d=$('log');const s=document.createElement('div');if(cls)s.className=cls;s.textContent=m;d.appendChild(s);d.scrollTop=d.scrollHeight}
function status(m){$('status').textContent=m}
function busy(b,btn,txt){btn.disabled=b;btn.innerHTML=b?'<span class="spin"></span>'+txt:btn.dataset.label}
async function api(method,url,body){const r=await fetch(url,{method,headers:body&&!(body instanceof Blob)?{'Content-Type':'application/json'}:undefined,body:body&&!(body instanceof Blob)?JSON.stringify(body):body});const j=await r.json();if(!r.ok||j.error){throw new Error(j.error||r.statusText)}return j}
function saveSettings(){const o={};for(const k of settingsKeys){const e=$(k);o[k]=e.type==='checkbox'?e.checked:e.value}if(!o.ftp_remember)o.ftp_pass='';localStorage.setItem('maxine-studio',JSON.stringify(o))}
function loadSettings(){try{const o=JSON.parse(localStorage.getItem('maxine-studio')||'{}');for(const k of settingsKeys){if(!(k in o))continue;const e=$(k);if(e.type==='checkbox')e.checked=!!o[k];else e.value=o[k]}}catch(e){}}
for(const k of settingsKeys){$(k).addEventListener('change',saveSettings)}
$('code').addEventListener('input',()=>{$('outname').textContent='.'+$('code').value});
['convert','ftp_test','ftp_upload','download','openpng'].forEach(id=>$(id).dataset.label=$(id).innerHTML);

// ---- system fonts
let FONTS=[];
function renderFonts(){const q=$('search').value.toLowerCase();const sel=$('sysfont');sel.innerHTML='';for(const f of FONTS){if(q&&!f.name.toLowerCase().includes(q))continue;const o=document.createElement('option');o.value=JSON.stringify(f);o.textContent=f.name;sel.appendChild(o)}}
$('search').addEventListener('input',renderFonts);
$('sysfont').addEventListener('change',()=>{const f=JSON.parse($('sysfont').value);chooseFont(f.path,f.index,[f.name])});
function chooseFont(path,index,faces){S.ttf=path;S.index=index||0;$('chosen').textContent=path;const fs=$('face');fs.innerHTML='';(faces||[]).forEach((n,i)=>{const o=document.createElement('option');o.value=i;o.textContent=n;if(i===S.index)o.selected=true;fs.appendChild(o)});if(!$('name').value||$('name').dataset.auto==='1'){$('name').value=(faces&&faces[S.index])||'';$('name').dataset.auto='1'}}
$('name').addEventListener('input',()=>{$('name').dataset.auto='0'});
$('face').addEventListener('change',()=>{S.index=+$('face').value;if($('name').dataset.auto==='1')$('name').value=$('face').options[S.index].textContent});
// ---- upload
$('pick').onclick=()=>$('file').click();
$('file').onchange=()=>{if($('file').files[0])uploadFont($('file').files[0])};
const drop=$('drop');['dragenter','dragover'].forEach(e=>drop.addEventListener(e,ev=>{ev.preventDefault();drop.classList.add('over')}));
['dragleave','drop'].forEach(e=>drop.addEventListener(e,ev=>{ev.preventDefault();drop.classList.remove('over')}));
drop.addEventListener('drop',ev=>{const f=ev.dataTransfer.files[0];if(f)uploadFont(f)});
async function uploadFont(file){try{status('Uploading '+file.name+' …');const r=await fetch('/api/upload',{method:'PUT',headers:{'X-Filename':encodeURIComponent(file.name)},body:file});const j=await r.json();if(j.error)throw new Error(j.error);chooseFont(j.path,0,j.faces);log('Loaded '+file.name+' ('+j.faces.length+' face'+(j.faces.length>1?'s':'')+')','ok');status('Ready')}catch(e){log('Upload failed: '+e.message,'err');status('Error')}}
// ---- convert
$('convert').onclick=async()=>{if(!S.ttf){log('Choose a font first.','err');return}const code=$('code').value.trim();if(!/^\d{4}$/.test(code)){log('The font code must be exactly 4 digits.','err');return}
 saveSettings();busy(true,$('convert'),'Converting…');status('Converting…');
 try{const j=await api('POST','/api/convert',{ttf:S.ttf,index:S.index,scanlines:$('scanlines').value,code,master_id:$('master_id').value,name:$('name').value,edge:$('edge').value,lines:$('lines').value,aspect:$('aspect').value,spacing:$('spacing').value,kern:$('kern').checked,out:$('out').value});
  S.last=j;j.log.forEach(l=>log(l));log('Converted → '+j.path+' ('+j.size+' bytes)','ok');
  $('preview').innerHTML='<img src="/api/preview?path='+encodeURIComponent(j.png)+'&t='+Date.now()+'">';
  $('stats').innerHTML=`<span><b>${j.glyphs}</b> glyphs</span><span><b>${j.kern}</b> kern pairs</span><span>cell <b>${j.cell_rows}</b> rows</span><span>ascent <b>${j.ascent}</b></span><span>descent <b>${j.descent}</b></span><span>baseline row <b>${j.baseline_row}</b></span><span>${(j.size/1024).toFixed(1)} KB</span>`;
  $('ftp_upload').disabled=false;$('download').disabled=false;$('openpng').disabled=false;status('Converted — not yet tested on hardware');refreshFiles()}
 catch(e){log('Conversion failed: '+e.message,'err');status('Error')}
 busy(false,$('convert'))};
$('download').onclick=()=>{if(S.last)location.href='/api/download?path='+encodeURIComponent(S.last.path)};
$('openpng').onclick=()=>{if(S.last)window.open('/api/preview?path='+encodeURIComponent(S.last.png))};
// ---- ftp
function ftpCfg(){return{host:$('ftp_host').value,port:$('ftp_port').value,user:$('ftp_user').value,password:$('ftp_pass').value,dir:$('ftp_dir').value,passive:$('ftp_passive').checked}}
$('ftp_test').onclick=async()=>{saveSettings();busy(true,$('ftp_test'),'Connecting…');try{const j=await api('POST','/api/ftp/list',ftpCfg());log('Connected: '+j.welcome,'ok');log('Remote dir '+j.cwd+' ('+j.entries.length+' entries):');j.entries.forEach(e=>log('  '+e));status('FTP OK')}catch(e){log('FTP failed: '+e.message,'err');status('FTP error')}busy(false,$('ftp_test'))};
async function ftpUpload(path){saveSettings();const name=path.split('/').pop();if(!confirm('Upload '+name+' to '+$('ftp_host').value+'?\n\nLoad it on the MAXINE one file at a time and stop if the unit fails to load it or hangs.'))return;
 busy(true,$('ftp_upload'),'Uploading…');try{const j=await api('POST','/api/ftp/upload',Object.assign(ftpCfg(),{path}));log('Uploaded '+j.remote_name+' ('+j.local_size+' bytes'+(j.remote_size!=null?', remote reports '+j.remote_size:'')+')','ok');status('Uploaded '+j.remote_name+' — now load it on the unit and photograph the CRT')}catch(e){log('Upload failed: '+e.message,'err');status('FTP error')}busy(false,$('ftp_upload'))}
$('ftp_upload').onclick=()=>{if(S.last)ftpUpload(S.last.path)};
// ---- outputs table
function showFile(f){$('preview').innerHTML='<img src="/api/preview?path='+encodeURIComponent(f.path+'.png')+'&t='+Date.now()+'">';S.last={path:f.path,png:f.path+'.png'};$('ftp_upload').disabled=false;$('download').disabled=false;$('openpng').disabled=false;$('stats').innerHTML=`<span><b>${f.file}</b></span><span>${f.name}</span><span>${f.desc}</span><span>${(f.size/1024).toFixed(1)} KB</span>`}
async function refreshFiles(){try{const j=await api('GET','/api/outputs');if(!$('out').value)$('out').value=j.out;const tb=$('files').querySelector('tbody');tb.innerHTML='';
 if(!S.last){const newest=j.files.filter(f=>f.preview).sort((a,b)=>b.mtime-a.mtime)[0];if(newest)showFile(newest)}
 for(const f of j.files){const tr=document.createElement('tr');tr.innerHTML=`<td><b>${f.file}</b></td><td>${f.name}</td><td>${f.desc}</td><td>${(f.size/1024).toFixed(1)} KB</td><td></td>`;const td=tr.lastChild;
  if(f.preview){const b=document.createElement('button');b.className='secondary';b.textContent='Preview';b.onclick=()=>showFile(f);td.appendChild(b)}
  const u=document.createElement('button');u.textContent='Upload';u.style.marginLeft='6px';u.onclick=()=>ftpUpload(f.path);td.appendChild(u);tb.appendChild(tr)}}catch(e){log('Could not list outputs: '+e.message,'err')}}
// ---- init
loadSettings();$('outname').textContent='.'+$('code').value;
api('GET','/api/system-fonts').then(f=>{FONTS=f;renderFonts();log(f.length+' installed font faces found.')}).catch(e=>log('Font scan failed: '+e.message,'err'));
refreshFiles();
</script>
</body></html>
"""


def main(argv=None):
    ap = argparse.ArgumentParser(description="MAXINE Font Studio web UI")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--out", default=DEFAULT_OUT, help="default output folder for converted fonts")
    ap.add_argument("--no-browser", action="store_true")
    ap.add_argument("--verbose", action="store_true")
    a = ap.parse_args(argv)
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    srv.out_dir = os.path.abspath(a.out); srv.verbose = a.verbose
    url = f"http://127.0.0.1:{a.port}/"
    print("MAXINE Font Studio:", url, "(Ctrl-C to stop)")
    if not a.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
