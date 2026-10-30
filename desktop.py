#!/usr/bin/python3
import os, json, secrets, subprocess, shutil, threading, tempfile, fcntl
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
import http.client

ASSETS = Path(__file__).resolve().parent/'extension'
MAX_BODY = 32*1024*1024
class Store:
    def __init__(self, directory):
        self.directory=Path(directory); self.directory.mkdir(parents=True,exist_ok=True,mode=0o700)
        self.path=self.directory/'payroll.json'; self.lock=threading.Lock()
    def read(self):
        with self.lock:
            if not self.path.exists(): return {}
            return json.loads(self.path.read_text())
    def write(self, data):
        if not isinstance(data,dict) or not isinstance(data.get('payroll'),dict): raise ValueError('Invalid payroll data')
        with self.lock:
            fd,name=tempfile.mkstemp(dir=self.directory,prefix='.payroll-')
            try:
                with os.fdopen(fd,'w') as f:
                    json.dump(data,f); f.flush(); os.fsync(f.fileno())
                if self.path.exists():
                    backup=self.directory/'payroll.previous.json'
                    shutil.copyfile(self.path,backup); backup.chmod(0o600)
                os.replace(name,self.path)
            finally:
                if os.path.exists(name): os.unlink(name)

def handler(store, token):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args): pass
        def respond(self, status, data, mime='application/json'):
            if not isinstance(data,bytes): data=json.dumps(data).encode()
            self.send_response(status);self.send_header('Content-Type',mime)
            self.send_header('Content-Length',str(len(data)));self.send_header('Cache-Control','no-store')
            self.send_header('X-Content-Type-Options','nosniff');self.send_header('Referrer-Policy','no-referrer')
            self.send_header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'")
            self.end_headers();self.wfile.write(data)
        def route(self):
            if self.headers.get('Host') != '127.0.0.1:'+str(self.server.server_port): return None
            prefix='/'+token+'/'
            return self.path[len(prefix):] if self.path.startswith(prefix) else None
        def do_GET(self):
            route=self.route()
            try:
                if route=='storage': return self.respond(200,store.read())
                types={'app.html':'text/html; charset=utf-8','app.css':'text/css','app.js':'text/javascript','desktop-bridge.js':'text/javascript'}
                if route in types: return self.respond(200,(ASSETS/route).read_bytes(),types[route])
                self.respond(404,{'error':'Not found'})
            except Exception: self.respond(500,{'error':'Unable to read application data. Check the payroll data file.'})
        def do_POST(self):
            route=self.route()
            origin='http://127.0.0.1:'+str(self.server.server_port)
            if route not in ('storage','proxy') or self.headers.get('X-Payroll-Token')!=token or self.headers.get('Origin') not in (None,origin):
                return self.respond(403,{'error':'Forbidden'})
            try:
                length=int(self.headers.get('Content-Length','0'))
                if length<1 or length>MAX_BODY: return self.respond(413,{'error':'Request too large'})
                data=json.loads(self.rfile.read(length))
                if route=='storage': store.write(data); return self.respond(200,{'ok':True})
                target=urlsplit(data['url'])
                if target.scheme!='https' or not target.hostname or target.username or target.password or target.query or target.fragment:
                    raise ValueError('Use an HTTPS Odoo URL without credentials or query parameters')
                if target.path!='/jsonrpc' and not target.path.startswith('/json/2/'):
                    raise ValueError('Unsupported Odoo API endpoint')
                headers={'Content-Type':'application/json'}
                for name,value in data.get('headers',{}).items():
                    if name.lower() in ('authorization','x-odoo-database'): headers[name]=value
                conn=http.client.HTTPSConnection(target.hostname,target.port or 443,timeout=60)
                try:
                    conn.request('POST',target.path,body=data['body'].encode(),headers=headers)
                    response=conn.getresponse();body=response.read(MAX_BODY+1)
                    if len(body)>MAX_BODY: raise ValueError('Odoo response too large')
                    self.respond(response.status,body,'application/json')
                finally: conn.close()
            except Exception as e: self.respond(502 if route=='proxy' else 400,{'message':str(e)})
    return Handler

def main():
    import tkinter as tk
    from tkinter import messagebox
    if os.getuid()==0: raise SystemExit('Run as your desktop user, without sudo.')
    os.umask(0o077)
    root=tk.Tk();root.title('Odoo Payroll Helper');root.resizable(False,False)
    tk.Label(root,text='Choose a browser',font=('',16,'bold')).pack(padx=30,pady=(20,10))
    selected=tk.StringVar(); commands={}
    for label,candidates in [('Brave',['brave-browser','brave']),('Firefox',['firefox']),('Chrome',['google-chrome','google-chrome-stable']),('Chromium',['chromium','chromium-browser'])]:
        command=next((shutil.which(c) for c in candidates if shutil.which(c)),None)
        if command: commands[label]=command
        tk.Radiobutton(root,text=label if command else label+' (not installed)',variable=selected,value=label,state='normal' if command else 'disabled').pack(anchor='w',padx=30)
    if commands: selected.set(next(iter(commands)))
    def launch():
        if selected.get() not in commands: return messagebox.showerror('Browser required','Install Brave, Firefox, Chrome or Chromium first.')
        directory=Path.home()/'.local/share/odoo-payroll-helper'
        store=Store(directory)
        lock=open(directory/'desktop.lock','a+')
        try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:
            lock.close()
            try:
                url=json.loads((directory/'session.json').read_text())['url']
                subprocess.Popen([commands[selected.get()],url]);root.destroy()
            except Exception as e: messagebox.showerror('Open application',str(e))
            return
        token=secrets.token_urlsafe(32)
        server=ThreadingHTTPServer(('127.0.0.1',0),handler(store,token));server.daemon_threads=True
        url=f'http://127.0.0.1:{server.server_port}/{token}/app.html'
        (directory/'session.json').write_text(json.dumps({'url':url}))
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try: subprocess.Popen([commands[selected.get()],url])
        except Exception as e:
            server.shutdown();lock.close();return messagebox.showerror('Open browser',str(e))
        root._lock=lock;root._server=server
        for child in root.winfo_children(): child.destroy()
        tk.Label(root,text='Payroll Helper is running in your browser.\nKeep this window open while using it.').pack(padx=25,pady=20)
        tk.Button(root,text='Reopen browser',command=lambda:subprocess.Popen([commands[selected.get()],url])).pack(pady=5)
        def stop(): server.shutdown();server.server_close();lock.close();root.destroy()
        tk.Button(root,text='Stop application',command=stop).pack(pady=(5,20));root.protocol('WM_DELETE_WINDOW',stop)
    tk.Button(root,text='Open Payroll Helper',command=launch).pack(padx=30,pady=20)
    root.mainloop()
if __name__=='__main__': main()
