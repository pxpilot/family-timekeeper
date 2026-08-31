#!/usr/bin/env python3
"""Pack the extension folder into a signed CRX3 and emit the matching update.xml.

Usage:
    python3 pack_crx.py <extension-dir> <private-key.pem> <out-dir> <version> <update-base-url>
"""
import hashlib
import os
import struct
import sys
import zipfile

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

SKIP_DIRS = {"install", "test", "tools", "dist", "docs", "node_modules", ".git", ".github"}
SKIP_FILES = {"package.json", "package-lock.json", ".DS_Store"}
SKIP_EXTS = (".crx", ".zip", ".md", ".pem")


def varint(n: int) -> bytes:
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        out.append(b | (0x80 if n else 0))
        if not n:
            return bytes(out)


def field(num: int, payload: bytes) -> bytes:
    return varint((num << 3) | 2) + varint(len(payload)) + payload


def build_zip(src: str, dest: str) -> None:
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as z:
        for root, dirs, files in os.walk(src):
            dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(".")]
            for f in sorted(files):
                if f in SKIP_FILES or f.endswith(SKIP_EXTS):
                    continue
                full = os.path.join(root, f)
                z.write(full, os.path.relpath(full, src).replace(os.sep, "/"))


def main() -> None:
    src, keyfile, outdir, version, base_url = sys.argv[1:6]
    os.makedirs(outdir, exist_ok=True)
    zip_path = os.path.join(outdir, "timekeeper.zip")
    crx_path = os.path.join(outdir, "timekeeper.crx")

    build_zip(src, zip_path)
    zip_bytes = open(zip_path, "rb").read()

    key = serialization.load_pem_private_key(open(keyfile, "rb").read(), password=None)
    pub_der = key.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    crx_id = hashlib.sha256(pub_der).digest()[:16]
    ext_id = "".join(chr(ord("a") + (b >> 4)) + chr(ord("a") + (b & 0xF)) for b in crx_id)

    signed_header = field(1, crx_id)                       # SignedData{ crx_id }
    to_sign = (b"CRX3 SignedData\x00"
               + struct.pack("<I", len(signed_header))
               + signed_header
               + zip_bytes)
    sig = key.sign(to_sign, padding.PKCS1v15(), hashes.SHA256())

    header = field(2, field(1, pub_der) + field(2, sig)) + field(10000, signed_header)
    with open(crx_path, "wb") as f:
        f.write(b"Cr24" + struct.pack("<II", 3, len(header)) + header + zip_bytes)

    with open(os.path.join(outdir, "update.xml"), "w") as f:
        f.write(
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">\n'
            f'  <app appid="{ext_id}">\n'
            f'    <updatecheck codebase="{base_url.rstrip("/")}/timekeeper.crx" version="{version}" />\n'
            "  </app>\n"
            "</gupdate>\n"
        )

    print(f"extension id : {ext_id}")
    print(f"crx          : {crx_path} ({len(open(crx_path, 'rb').read()):,} bytes)")
    print(f"update.xml   : {os.path.join(outdir, 'update.xml')}")


if __name__ == "__main__":
    main()
