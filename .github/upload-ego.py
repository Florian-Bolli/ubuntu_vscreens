#!/usr/bin/env python3
"""Submit a packed extension zip to extensions.gnome.org for review.

Reads EGO_USERNAME and EGO_PASSWORD from the environment. The site still
reviews the upload; this does not publish it.
"""

import os
import sys

import requests
from bs4 import BeautifulSoup

LOGIN_URL = "https://extensions.gnome.org/accounts/login/"
UPLOAD_PAGE = "https://extensions.gnome.org/upload/"
UPLOAD_URL = "https://extensions.gnome.org/api/v1/extensions"


def fail(message):
    print(message, file=sys.stderr)
    raise SystemExit(1)


def csrf_from(html):
    field = BeautifulSoup(html, "html.parser").find(
        "input", {"name": "csrfmiddlewaretoken"})
    if field is None or not field.get("value"):
        fail("extensions.gnome.org did not return a CSRF token.")
    return field["value"]


def main():
    if len(sys.argv) != 2:
        fail(f"Usage: {sys.argv[0]} <extension.zip>")

    zip_path = sys.argv[1]
    username = os.environ.get("EGO_USERNAME", "")
    password = os.environ.get("EGO_PASSWORD", "")
    if not username or not password:
        fail("Set repository secrets EGO_USERNAME and EGO_PASSWORD.")
    if not os.path.isfile(zip_path):
        fail(f"Zip not found: {zip_path}")

    session = requests.Session()
    session.headers["User-Agent"] = "vscreens-ego-upload"

    login_page = session.get(LOGIN_URL, timeout=60)
    if login_page.status_code != 200:
        fail(f"Could not open the login page (HTTP {login_page.status_code}).")

    login = session.post(
        LOGIN_URL,
        data={
            "username": username,
            "password": password,
            "csrfmiddlewaretoken": csrf_from(login_page.text),
        },
        headers={"Referer": LOGIN_URL},
        timeout=60,
    )
    error = BeautifulSoup(login.text, "html.parser").find(class_="errorlist")
    if error is not None:
        fail(f"Login failed: {error.get_text(' ', strip=True)}")
    if login.status_code != 200:
        fail(f"Login failed (HTTP {login.status_code}).")

    upload_page = session.get(UPLOAD_PAGE, timeout=60)
    if upload_page.status_code != 200:
        fail(f"Could not open the upload page (HTTP {upload_page.status_code}).")
    csrf_cookie = session.cookies.get("csrftoken")
    if not csrf_cookie:
        fail("Login did not keep a CSRF cookie.")

    with open(zip_path, "rb") as source:
        upload = session.post(
            UPLOAD_URL,
            data={
                "shell_license_compliant": "true",
                "tos_compliant": "true",
                "csrfmiddlewaretoken": csrf_from(upload_page.text),
            },
            files={"source": (os.path.basename(zip_path), source, "application/zip")},
            headers={
                "Referer": UPLOAD_PAGE,
                "Origin": "https://extensions.gnome.org",
                "X-CSRFToken": csrf_cookie,
            },
            timeout=120,
            allow_redirects=False,
        )

    if upload.status_code not in (201, 302):
        body = " ".join(upload.text.split())[:500]
        fail(f"Upload failed (HTTP {upload.status_code}): {body}")

    print(f"Submitted {os.path.basename(zip_path)} for review.")


if __name__ == "__main__":
    main()
