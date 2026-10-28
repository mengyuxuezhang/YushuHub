"""Recover version archives and reviewed version messages without copying source code or operational records."""
import argparse
import json
import re
import subprocess
from pathlib import Path

VERSION = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$")
METADATA = ("commit", "repository", "gitTag", "recordType", "dateSource", "gitNotes", "gitNotesSource")
SENSITIVE = re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|root@|git@|ssh://|/root/|/www/wwwroot/|(?:password|api[_-]?key|secret|token)\s*[:=]\s*['\"]?[A-Za-z0-9_/-]{16,}", re.I)
OPERATIONS = re.compile(r"\b(?:pm2|deploy(?:ment)?|signing|whitelist)\b|运维|凭据|私钥|同步.{0,12}构建机|root@|[A-Z]:\\|(?:\d{1,3}\.){3}\d{1,3}|(?:password|secret|token|密码|密钥)\s*[:=：]\s*\S+", re.I)


def displayable_git_notes(value):
    text = str(value or '').split('-----BEGIN PGP SIGNATURE-----')[0].strip()
    if not text or len(text) > 4000 or SENSITIVE.search(text) or OPERATIONS.search(text):
        return ''
    meaning = re.sub(r'\[[A-Z]+\d+[^\]]*\]', '', text)
    meaning = re.sub(r'v?\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?', '', meaning)
    meaning = re.sub(r'\b(?:release|desktop|agent|version|prepare|chore|build|tag)\b|发布|版本|准备|管理端|源码', '', meaning, flags=re.I)
    return text if len(re.sub(r'[^\w\u4e00-\u9fff]', '', meaning)) >= 6 else ''


def apply_note_translations(rows, translations):
    for row in rows:
        for original, localized in [('gitNotes', 'gitNotesZh'), ('releaseNotes', 'releaseNotesZh')]:
            row.pop(localized, None)
            translated = translations.get(row.get(original, ''))
            if isinstance(translated, str) and re.search(r'[\u4e00-\u9fff]', translated):
                row[localized] = translated.strip()
    return rows


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
    messages = git(repo, 'log', '--all', '--format=%H%x00%cI%x00%B%x00', '--', history_path, *package_paths).split('\0')
    dated, commit_messages = {}, {}
    for index in range(0, len(messages) - 2, 3):
        sha, date, message = messages[index].strip(), messages[index + 1].strip(), messages[index + 2].strip()
        dated[sha], commit_messages[sha] = date, message
    tags = [tag for tag in git(repo, "tag", "--list", "v*").splitlines() if VERSION.fullmatch(tag[1:])]
    specs = [f"{sha}:{file}" for sha in dated for file in [history_path, *package_paths]]
    specs += [f"{tag}:release/latest.json" for tag in tags]
    data = blobs(repo, specs)
    raw_tags = git(repo, 'for-each-ref', '--format=%(refname:short)%00%(objecttype)%00%(contents)%00', 'refs/tags').split('\0')
    tag_messages = {raw_tags[i].strip(): (raw_tags[i + 1], raw_tags[i + 2]) for i in range(0, len(raw_tags) - 2, 3)}
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
                notes = displayable_git_notes(commit_messages[sha])
                if notes:
                    metadata[version].update(gitNotes=notes, gitNotesSource='commit')
    for tag in tags:
        sha, date = git(repo, "log", "-1", "--format=%H%n%cI", tag).splitlines()
        version = tag[1:]
        metadata[version] = {"commit": sha, "repository": name, "gitTag": tag, "publishedAt": date, "recordType": "git", "dateSource": "commit"}
        kind, message = tag_messages.get(tag, ('commit', ''))
        notes = displayable_git_notes(message)
        if not notes:
            notes = displayable_git_notes(commit_messages.get(sha) or git(repo, 'log', '-1', '--format=%B', tag))
            kind = 'commit'
        if notes:
            metadata[version].update(gitNotes=notes, gitNotesSource='tag' if kind == 'tag' else 'commit')
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


def archive(product, sources, existing, previous=()):
    result = {}
    for repo in sources:
        for version, row in collect(repo, product).items():
            if version not in result:
                result[version] = dict(row)
                continue
            target = result[version]
            conflict = product == 'agent' and target.get('commit') and row.get('commit') and target['commit'] != row['commit']
            if row.get("gitTag") and not target.get("gitTag") and not conflict:
                target.update({key: row[key] for key in ("commit", "repository", "gitTag") if key in row})
            for key, value in row.items():
                if conflict and key in ('releaseNotes', 'gitNotes', 'gitNotesSource', 'commit', 'repository', 'gitTag'):
                    continue
                if not target.get(key) and value:
                    target[key] = value
    # Keep recovered old-repository records even when that source is unavailable on a later run.
    for row in previous:
        if not VERSION.fullmatch(str(row.get('version', ''))):
            continue
        target = result.setdefault(row['version'], {'version': row['version']})
        for key in ('publishedAt', 'releaseNotes', *METADATA):
            if not target.get(key) and row.get(key):
                if key == 'gitNotes' and not displayable_git_notes(row[key]):
                    continue
                target[key] = row[key]
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
    parser.add_argument("--agent-history-repo", action='append', type=Path, default=[], help='Read an additional historical Desktop repository; may be repeated')
    parser.add_argument("--output-dir", type=Path, default=Path(__file__).resolve().parents[1] / "docs")
    parser.add_argument("--write", action="store_true", help="Write archive files; otherwise show a read-only summary")
    args = parser.parse_args()
    translation_file = Path(__file__).resolve().parents[1] / 'docs' / 'GIT_NOTE_TRANSLATIONS.json'
    translations = json.loads(translation_file.read_text(encoding='utf-8-sig')).get('translations', {}) if translation_file.exists() else {}
    for product, repos, history_file, archive_file in [
        ("admin", [args.admin_repo] + ([args.admin_legacy_repo] if args.admin_legacy_repo else []), "UPDATE_HISTORY.json", "ADMIN_RELEASE_ARCHIVE.json"),
        ("agent", [args.agent_repo, *args.agent_history_repo], "AGENT_UPDATE_HISTORY.json", "AGENT_RELEASE_ARCHIVE.json"),
    ]:
        history = args.output_dir / history_file
        existing = json.loads(history.read_text(encoding="utf-8-sig")) if history.exists() else []
        archive_path = args.output_dir / archive_file
        previous = json.loads(archive_path.read_text(encoding='utf-8-sig')) if archive_path.exists() else []
        rows = apply_note_translations(archive(product, repos, existing, previous), translations)
        if args.write:
            args.output_dir.mkdir(parents=True, exist_ok=True)
            (args.output_dir / archive_file).write_text(json.dumps(rows, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"product": product, "versions": len(rows), "newest": rows[0]["version"], "oldest": rows[-1]["version"], "gitOnly": sum(row.get("recordType") == "git" for row in rows), "formalNotes": sum(bool(row.get('releaseNotes')) for row in rows), "gitNotesFallback": sum(not row.get('releaseNotes') and bool(row.get('gitNotes')) for row in rows), "missingNotes": sum(not row.get("releaseNotes") and not row.get('gitNotes') for row in rows), "written": args.write}))


if __name__ == "__main__":
    main()
