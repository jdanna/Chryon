#!/usr/bin/env python3
"""
Disassembles MAXINE firmware, including the pc-relative 32-bit forms Capstone can't decode:
4ebb 8170 disp32 (jsr), 487b 8170 (pea), 4xfb 8170 (lea). Needs capstone.

  python3 tools/dis68.py <file> <load base hex> <address hex> <count>
"""
import sys,struct
from capstone import Cs,CS_ARCH_M68K,CS_MODE_BIG_ENDIAN,CS_MODE_M68K_040
b=open(sys.argv[1],'rb').read(); base=int(sys.argv[2],16)
md=Cs(CS_ARCH_M68K,CS_MODE_BIG_ENDIAN+CS_MODE_M68K_040)
def sat(t):
    o=t-base
    if not 0<=o<len(b): return ''
    e=b.find(b'\0',o,o+70)
    s=b[o:e]
    return repr(s.decode('latin1')) if e>o and len(s)>3 and all(32<=c<127 for c in s) else ''
def one(o):
    x=b[o:o+10]
    if x[2:4]==b'\x81\x70' and x[:2] in(b'\x4e\xbb',b'\x48\x7b',b'\x41\xfb',b'\x43\xfb',b'\x45\xfb',b'\x47\xfb',b'\x49\xfb',b'\x4e\xfb'):
        t=o+2+struct.unpack('>i',x[4:8])[0]+base
        m={0x4ebb:'JSR',0x487b:'PEA',0x4efb:'JMP'}.get(x[0]<<8|x[1],'LEA a%d'%((x[0]>>1)&7))
        return 8,f"{m} ${t:x} {sat(t)}"
    for i in md.disasm(b[o:o+12],o+base,count=1): return i.size,f"{i.mnemonic} {i.op_str}"
    return 2,f".word {b[o:o+2].hex()}"
a=int(sys.argv[3],16)-base
for _ in range(int(sys.argv[4])):
    s,t=one(a); print(f"{a+base:06x}: {t}"); a+=s
