#!/usr/bin/env python3
"""App Store Connect API voor de CI, alleen standaardbibliotheek en openssl.

  asc.py team <bundle-id> <naam>   registreert de bundle-id als die nog niet bestaat, print de Team ID (seedId)
  asc.py app <bundle-id>           stopt met uitleg als er nog geen app bij de bundle-id is in App Store Connect

Leest ASC_KEY_ID, ASC_ISSUER_ID en ASC_KEY_PATH (pad naar het .p8-bestand) uit de omgeving.
"""
import base64
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API = "https://api.appstoreconnect.apple.com/v1/"


def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def der_to_raw(der: bytes) -> bytes:
    """ECDSA-handtekening van openssl (DER) → r||s van 64 bytes, zoals JWT ES256 wil."""
    i = 2 if der[1] < 0x80 else 2 + (der[1] & 0x7F)
    parts = []
    for _ in range(2):
        assert der[i] == 0x02, "geen DER-integer"
        length = der[i + 1]
        parts.append(der[i + 2 : i + 2 + length].lstrip(b"\0").rjust(32, b"\0"))
        i += 2 + length
    return parts[0] + parts[1]


def token() -> str:
    now = int(time.time())
    header = {"alg": "ES256", "kid": os.environ["ASC_KEY_ID"], "typ": "JWT"}
    payload = {"iss": os.environ["ASC_ISSUER_ID"], "iat": now, "exp": now + 900, "aud": "appstoreconnect-v1"}
    signing = b64(json.dumps(header).encode()) + "." + b64(json.dumps(payload).encode())
    der = subprocess.run(
        ["openssl", "dgst", "-sha256", "-sign", os.environ["ASC_KEY_PATH"]],
        input=signing.encode(), capture_output=True, check=True,
    ).stdout
    return signing + "." + b64(der_to_raw(der))


def api(method: str, path: str, body=None):
    req = urllib.request.Request(
        API + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": "Bearer " + token(), "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        sys.exit(f"::error::App Store Connect {method} {path}: {e.code} {e.read().decode()[:500]}")


def find_bundle(identifier: str):
    q = urllib.parse.urlencode({"filter[identifier]": identifier, "limit": 200})
    return [b for b in api("GET", "bundleIds?" + q)["data"] if b["attributes"]["identifier"] == identifier]


def cmd_team(identifier: str, name: str) -> None:
    found = find_bundle(identifier)
    if not found:
        body = {"data": {"type": "bundleIds", "attributes": {"identifier": identifier, "name": name, "platform": "IOS"}}}
        found = [api("POST", "bundleIds", body)["data"]]
        print(f"Bundle-id {identifier} geregistreerd.", file=sys.stderr)
    print(found[0]["attributes"]["seedId"])


def cmd_app(identifier: str) -> None:
    q = urllib.parse.urlencode({"filter[bundleId]": identifier})
    apps = [a for a in api("GET", "apps?" + q)["data"] if a["attributes"]["bundleId"] == identifier]
    if not apps:
        sys.exit(
            f"::error::Er is nog geen app voor {identifier} in App Store Connect. Maak hem één keer aan: "
            "appstoreconnect.apple.com → Apps → + → New App (iOS, naam Lessenaar, bundle-id "
            f"{identifier}, SKU lessenaar). Start daarna deze workflow opnieuw."
        )
    print(f"App gevonden: {apps[0]['attributes']['name']} ({apps[0]['id']})", file=sys.stderr)


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "team" and len(sys.argv) == 4:
        cmd_team(sys.argv[2], sys.argv[3])
    elif len(sys.argv) == 3 and sys.argv[1] == "app":
        cmd_app(sys.argv[2])
    else:
        sys.exit(__doc__)
