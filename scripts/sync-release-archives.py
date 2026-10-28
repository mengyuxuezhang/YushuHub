"""Recover version archives from Git without copying source code or private commit messages."""
import argparse
import json
import re
import subprocess
from pathlib import Path

VERSION = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$")
METADATA = ("commit", "repository", "gitTag", "recordType", "dateSource")
SENSITIVE = re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|root@|/root/|/www/wwwroot/|(?:password|api[_-]?key|secret|token)\s*[:=]\s*['\"]?[A-Za-z0-9_/-]{16,}", re.I)


def git(repo, *args):
    return subprocess.check_output(["git", "-C", str(repo), *args]).decode("utf-8").strip()


def blobs(repo, specs):
    specs = list(dict.fromkeys(specs))
    if not specs:
        return {}
    raw = subprocess.check_output(["git", "-C", str(repo), "cat-file", "--batch"], input=("\n".join(specs) + "\n").encode())
    offset, results = 0, {}
    for spec in specs:
        end = raw.index(b"\n", offset)
        header = raw[offset:end].decode()
        offset = end + 1
        if header.endswith(" missing"):
            continue
        _, kind, size = header.split()
        data = raw[offset:offset + int(size)]
        offset += int(size) + 1
        if kind == "blob":
            try:
                results[spec] = json.loads(data.decode("utf-8-sig"))
            except (UnicodeDecodeError, ValueError):
                pass
    return results


def version_key(value):
    core, _, pre = value.partition("-")
    return tuple(map(int, core.split("."))) + (tuple((0, int(p)) if p.isdigit() else (1, p) for p in pre.split(".")) if pre else ((2, ""),),)


def repository_name(repo):
    url = git(repo, "remote", "get-url", "origin")
    match = re.fullmatch(r"(?:https://github\.com/|git@github\.com:)([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+?)(?:\.git)?/?", url)
    if not match:
        raise ValueError("Archive sources must identify a GitHub repository")
    return match[1]


def collect(repo, product):
    name = repository_name(repo)
    history_path = "docs/UPDATE_HISTORY.json" if product == "admin" else "desktop/docs/UPDATE_HISTORY.json"
    package_paths = ["package.json"] if product == "admin" else ["desktop/package.json", "package.json"]
    commits = git(repo, "log", "--all", "--format=%H%x09%cI", "--", history_path, *package_paths).splitlines()
    dated = dict(row.split("\t", 1) for row in commits)
    tags = [tag for tag in git(repo, "tag", "--list", "v*").splitlines() if VERSION.fullmatch(tag[1:])]
    specs = [f"{sha}:{file}" for sha in dated for file in [history_path, *package_paths]]
    specs += [f"{tag}:release/latest.json" for tag in tags]
    data = blobs(repo, specs)
    entries, metadata, manifest_entries = {}, {}, {}
    # Newest archived wording wins. Root package version changes identify version commits.
    for sha, date in dated.items():
        rows = data.get(f"{sha}:{history_path}", [])
        if isinstance(rows, list):
            for row in rows:
                if isinstance(row, dict) and VERSION.fullmatch(str(row.get("version", ""))):
                    entries.setdefault(row["version"], row)
        for file in package_paths:
            package = data.get(f"{sha}:{file}", {})
            version = package.get("version", "") if isinstance(package, dict) else ""
            if VERSION.fullmatch(version) and (version.startswith("1.") if product == "admin" else version.startswith(("1.", "2.", "3."))):
                metadata[version] = {"commit": sha, "repository": name, "publishedAt": date, "recordType": "git", "dateSource": "commit"}
    for tag in tags:
        sha, date = git(repo, "log", "-1", "--format=%H%n%cI", tag).splitlines()
        version = tag[1:]
        metadata[version] = {"commit": sha, "repository": name, "gitTag": tag, "publishedAt": date, "recordType": "git", "dateSource": "commit"}
        manifest = data.get(f"{tag}:release/latest.json", {})
        if isinstance(manifest, dict) and manifest.get("version") == version:
            manifest_entries[version] = manifest
    result = {}
    for version in set(entries) | set(metadata):
        row = entries.get(version) or manifest_entries.get(version) or {}
        meta = metadata.get(version, {})
        notes = row.get("releaseNotes", "")
        if not isinstance(notes, str):
            notes = ""
        if SENSITIVE.search(notes):
            raise ValueError(f"{product} {version}: release wording needs a private-data review")
        result[version] = {"version": version, "publishedAt": str(row.get("publishedAt") or meta.get("publishedAt", "")), "releaseNotes": notes}
        result[version].update({key: meta[key] for key in METADATA if key in meta})
        if row.get("publishedAt"):
            result[version].pop("dateSource", None)
        if version in entries:
            result[version]["recordType"] = "git" if "test" in version else "release"
    return result


def archive(product, sources, existing):
    result = {}
    for repo in sources:
        for version, row in collect(repo, product).items():
            if version not in result:
                result[version] = dict(row)
                continue
            target = result[version]
            if row.get("gitTag") and not target.get("gitTag"):
                target.update({key: row[key] for key in ("commit", "repository", "gitTag") if key in row})
            for key, value in row.items():
                if not target.get(key) and value:
                    target[key] = value
    for row in existing:
        if not VERSION.fullmatch(str(row.get("version", ""))):
            continue
        item = result.setdefault(row["version"], {"version": row["version"]})
        item.update({key: row[key] for key in ("publishedAt", "releaseNotes") if row.get(key)})
        item["recordType"] = "release"
        if row.get("publishedAt"):
            item.pop("dateSource", None)
    # This immutable candidate was explicitly recorded as not deployed in the v1.9.56 release evidence.
    if product == "admin" and "1.9.55" in result:
        result["1.9.55"]["recordType"] = "unpublished"
    return sorted(result.values(), key=lambda row: version_key(row["version"]), reverse=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--admin-repo", required=True, type=Path)
    parser.add_argument("--admin-legacy-repo", type=Path)
    parser.add_argument("--agent-repo", required=True, type=Path)
    parser.add_argument("--output-dir", type=Path, default=Path(__file__).resolve().parents[1] / "docs")
    parser.add_argument("--write", action="store_true", help="Write archive files; otherwise show a read-only summary")
    args = parser.parse_args()
    for product, repos, history_file, archive_file in [
        ("admin", [args.admin_repo] + ([args.admin_legacy_repo] if args.admin_legacy_repo else []), "UPDATE_HISTORY.json", "ADMIN_RELEASE_ARCHIVE.json"),
        ("agent", [args.agent_repo], "AGENT_UPDATE_HISTORY.json", "AGENT_RELEASE_ARCHIVE.json"),
    ]:
        history = args.output_dir / history_file
        existing = json.loads(history.read_text(encoding="utf-8-sig")) if history.exists() else []
        rows = archive(product, repos, existing)
        if args.write:
            args.output_dir.mkdir(parents=True, exist_ok=True)
            (args.output_dir / archive_file).write_text(json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"product": product, "versions": len(rows), "newest": rows[0]["version"], "oldest": rows[-1]["version"], "gitOnly": sum(row.get("recordType") == "git" for row in rows), "missingNotes": sum(not row.get("releaseNotes") for row in rows), "written": args.write}))


if __name__ == "__main__":
    main()
