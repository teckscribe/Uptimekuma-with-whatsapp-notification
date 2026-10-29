#!/usr/bin/env python3
"""
Sets the web interface branding of Uptime Kuma to "Host Uptime Monitor".
Creates or updates the default Status Page, links all existing monitors,
sets the custom navbar CSS branding, and configures the entry page.
"""

import sys
import os
import sqlite3

BRAND_NAME = sys.argv[1] if len(sys.argv) > 1 else "Host Uptime Monitor"
DB_PATH = sys.argv[2] if len(sys.argv) > 2 else "uptime-kuma-data/kuma.db"

CUSTOM_CSS = f"""/* Custom Branding for {BRAND_NAME} */
.navbar-brand span {{
    display: none !important;
}}
.navbar-brand::after {{
    content: "{BRAND_NAME}" !important;
    font-weight: 700;
    font-size: 1.15rem;
    color: #ffffff;
    margin-left: 6px;
}}
"""

def main():
    if not os.path.exists(DB_PATH):
        print(f"[!] Database not found at {DB_PATH}. Is Uptime Kuma initialized?")
        return 1

    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    try:
        # 1. Check or insert default status_page
        cursor.execute("SELECT id FROM status_page WHERE slug = 'default'")
        row = cursor.fetchone()

        if row:
            status_page_id = row[0]
            cursor.execute("""
                UPDATE status_page SET
                    title = ?,
                    description = ?,
                    custom_css = ?,
                    show_powered_by = 0,
                    published = 1,
                    modified_date = datetime('now')
                WHERE id = ?
            """, (BRAND_NAME, "Real-time host availability & power outage monitoring", CUSTOM_CSS, status_page_id))
            print(f"[+] Updated Status Page #{status_page_id} to '{BRAND_NAME}'")
        else:
            cursor.execute("""
                INSERT INTO status_page (
                    slug, title, description, icon, theme, published,
                    search_engine_index, show_tags, created_date, modified_date,
                    footer_text, custom_css, show_powered_by, auto_refresh_interval
                ) VALUES (
                    'default', ?, 'Real-time host availability & power outage monitoring',
                    '/icon.svg', 'auto', 1, 0, 1, datetime('now'), datetime('now'),
                    '', ?, 0, 60
                )
            """, (BRAND_NAME, CUSTOM_CSS))
            status_page_id = cursor.lastrowid
            print(f"[+] Created Status Page #{status_page_id} with title '{BRAND_NAME}'")

        # 2. Ensure a group exists for this status page
        cursor.execute("SELECT id FROM [group] WHERE status_page_id = ?", (status_page_id,))
        group_row = cursor.fetchone()
        if group_row:
            group_id = group_row[0]
        else:
            cursor.execute("""
                INSERT INTO [group] (name, public, active, weight, status_page_id)
                VALUES ('Host Monitors', 1, 1, 1000, ?)
            """, (status_page_id,))
            group_id = cursor.lastrowid
            print(f"[+] Created group 'Host Monitors' (#{group_id}) for status page")

        # 3. Associate all active monitors to this group
        cursor.execute("SELECT id FROM monitor WHERE active = 1")
        monitors = cursor.fetchall()
        added_count = 0
        for (m_id,) in monitors:
            cursor.execute("SELECT id FROM monitor_group WHERE monitor_id = ? AND group_id = ?", (m_id, group_id))
            if not cursor.fetchone():
                cursor.execute("""
                    INSERT INTO monitor_group (monitor_id, group_id, weight, send_url)
                    VALUES (?, ?, 1000, 0)
                """, (m_id, group_id))
                added_count += 1

        if added_count > 0:
            print(f"[+] Linked {added_count} monitor(s) to the '{BRAND_NAME}' status page")

        # 4. Set Entry Page in setting table to this status page
        cursor.execute("SELECT key FROM setting WHERE key = 'entryPage'")
        if cursor.fetchone():
            cursor.execute("UPDATE setting SET value = '\"statusPage-default\"' WHERE key = 'entryPage'")
        else:
            cursor.execute("INSERT INTO setting (key, value) VALUES ('entryPage', '\"statusPage-default\"')")
        print(f"[+] Configured default entry page to '{BRAND_NAME}'")

        conn.commit()
        print(f"[OK] Successfully rebranded interface to '{BRAND_NAME}'!")
        return 0

    except Exception as e:
        conn.rollback()
        print(f"[-] Error applying branding: {e}")
        return 1
    finally:
        conn.close()

if __name__ == "__main__":
    sys.exit(main())
