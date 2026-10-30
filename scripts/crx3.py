#!/usr/bin/env python3
"""Pack a Chromium CRX3 using a persistent RSA PEM signing key and OpenSSL."""
import base64, hashlib, io, json, struct, subprocess, tempfile, zipfile
from pathlib import Path

def varint(n):
    result=bytearray()
    while n>127: result.append((n&127)|128);n>>=7
    result.append(n);return bytes(result)
def field(number,value):return varint((number<<3)|2)+varint(len(value))+value

def pack(source,key,output,update_url,version):
    public=subprocess.check_output(['openssl','pkey','-in',str(key),'-pubout','-outform','DER'],stderr=subprocess.DEVNULL)
    digest=hashlib.sha256(public).digest()[:16]
    extension_id=''.join(chr(97+int(c,16)) for c in digest.hex())
    manifest=json.loads((source/'manifest-chrome.json').read_text())
    manifest.update(key=base64.b64encode(public).decode(),update_url=update_url,version=version)
    buffer=io.BytesIO()
    with zipfile.ZipFile(buffer,'w',zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('manifest.json',json.dumps(manifest))
        for name in ('background.js','content.js'):archive.write(source/name,name)
    payload=buffer.getvalue();signed_data=field(1,digest)
    signing_bytes=b'CRX3 SignedData\x00'+struct.pack('<I',len(signed_data))+signed_data+payload
    with tempfile.TemporaryDirectory() as tmp:
        data=Path(tmp)/'signed-data';data.write_bytes(signing_bytes)
        signature=subprocess.check_output(['openssl','dgst','-sha256','-sign',str(key),str(data)])
    proof=field(1,public)+field(2,signature)
    header=field(2,proof)+field(10000,signed_data)
    output.write_bytes(b'Cr24'+struct.pack('<II',3,len(header))+header+payload)
    return extension_id
