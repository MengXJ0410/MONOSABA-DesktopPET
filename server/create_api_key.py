"""在 AstrBot 容器内生成一个 plugin scope 的 API Key。

用法（在服务器上）：
    docker exec -i astrbot python3 - < create_api_key.py

只输出一行 `abk_...`，把它写入桌宠 config.json 的 chat.apiKey。
重复运行会撤销旧的 DesktopPET key，再生成新的。
"""

from __future__ import annotations

import datetime
import hashlib
import secrets
import sqlite3
import uuid

DB_PATH = "/AstrBot/data/data_v4.db"
NAME = "DesktopPET"
SCOPES = '["plugin"]'
CREATED_BY = "MXJ0410"


def main() -> None:
    raw_key = f"abk_{secrets.token_urlsafe(32)}"
    key_hash = hashlib.pbkdf2_hmac(
        "sha256",
        raw_key.encode("utf-8"),
        b"astrbot_api_key",
        100_000,
    ).hex()
    now = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)

    con = sqlite3.connect(DB_PATH, timeout=15)
    try:
        con.execute(
            "update api_keys set revoked_at = ?, updated_at = ? "
            "where name = ? and revoked_at is null",
            (now, now, NAME),
        )
        con.execute(
            "insert into api_keys "
            "(created_at, updated_at, key_id, name, key_hash, key_prefix, scopes, created_by) "
            "values (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                now,
                now,
                str(uuid.uuid4()),
                NAME,
                key_hash,
                raw_key[:12],
                SCOPES,
                CREATED_BY,
            ),
        )
        con.commit()
    finally:
        con.close()

    print(raw_key)


if __name__ == "__main__":
    main()
