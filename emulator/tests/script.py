#!/usr/bin/env python3
"""
Builds scripts for drive.lua. Starts at the Loader, with the mouse at its start position:

    s = Script()
    s.click(268, 198); s.wait(1250)       # Message Compose
    s.key(0xd5); s.wait(120); s.key(0x46) # CNTL, F
    s.write('out.txt')
"""
import sys
class Script:
    def __init__(s): s.L=[]; s.n=660; s.x=660; s.y=450
    def at(s,txt): s.L.append(f'{s.n} {txt}')
    def wait(s,f): s.n+=f
    def key(s,k): s.at(f'key {k:02x}'); s.n+=12
    def text(s,t):
        for c in t: s.key(ord(c))
    def raw(s,dx,dy,b=0): s.at(f'mouse {dx&0xff:02x}{dy&0xff:02x}00{b:02x}'); s.n+=3
    def home(s):
        for i in range(30): s.raw(-50,-50)
        s.x=0;s.y=0
    def goto(s,x,y):
        if s.x is None: s.home()
        dx=x-s.x; dy=y-s.y
        while dx or dy:
            a=max(-50,min(50,dx)); b=max(-50,min(50,dy))
            s.raw(a,b); dx-=a; dy-=b
        s.x=x;s.y=y; s.n+=6
    def click(s,x=None,y=None,btn=1):
        if x is not None: s.goto(x,y)
        s.raw(0,0,btn); s.n+=8; s.raw(0,0,0); s.n+=8
    def snap(s,w=0):
        s.n+=w; s.at('snap'); s.n+=4
    def write(s,f):
        s.at('quit')
        open(f,'w').write('\n'.join(s.L)+'\n')
