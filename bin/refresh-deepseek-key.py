"""Refresh Tree's DEEPSEEK_API_KEY in ../.env from the stored connection.

The real key lives in the Secure Vault (custom.deepseek) and is never
readable. authd hands out an ``hsurr:*`` surrogate; Sentinel swaps in
the real key on approved egress to api.deepseek.com. Tree's server sends
that surrogate as its Bearer token, so a fresh surrogate must be written
into .env whenever the old one stops working (e.g. after a restart).
Usage: python3 bin/refresh-deepseek-key.py
"""
import re
import sys
from pathlib import Path

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import dynamic_credential_entry

ENV_PATH = Path(__file__).resolve().parent.parent / ".env"


def main() -> int:
    entry = dynamic_credential_entry("custom.deepseek", "access_token")
    surrogate = str(entry["surrogate"]).strip()
    if not surrogate.startswith("hsurr:"):
        raise SystemExit("authd did not return a surrogate")
    text = ENV_PATH.read_text(encoding="utf-8")
    updated, count = re.subn(
        r"^DEEPSEEK_API_KEY=.*$",
        f"DEEPSEEK_API_KEY={surrogate}",
        text,
        count=1,
        flags=re.MULTILINE,
    )
    if count != 1:
        raise SystemExit(".env has no DEEPSEEK_API_KEY line to replace")
    ENV_PATH.write_text(updated, encoding="utf-8")
    print("DEEPSEEK_API_KEY refreshed in .env (surrogate, not the real key).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
