"""Pinned package and reversible installer tests. Unit service driver, no host writes."""
import gzip
import io
import json
import os
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import delivery
from state import atomic_json, locks


def fixture_archive(version='0.1.0-rc.1', revision='a'*40):
    files = {name: ('fictional controller ' + name).encode() for name in delivery.FILES}
    files['yushuhub-upgrade@.service'] = b'[Service]\nExecStart=/usr/local/sbin/yushuhub-upgrade serve --instance %i\n'
    manifest = {'format': 1, 'kind': 'yushuhub-controller', 'version': version,
        'sourceRevision': revision, 'platform': 'linux/amd64', 'keys': {},
        'files': {name: {'sha256': delivery.sha(raw), 'bytes': len(raw)} for name, raw in files.items()}}
    files['release-manifest.json'] = delivery.canonical(manifest)
    return archive_files(files), files


def archive_files(files, extra=None):
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode='w:gz') as archive:
        for name, raw in files.items():
            entry = tarfile.TarInfo('controller/' + name)
            entry.size = len(raw)
            archive.addfile(entry, io.BytesIO(raw))
        if extra:
            archive.addfile(extra)
    return out.getvalue()


class ArchiveTest(unittest.TestCase):
    def test_digest_revision_file_contract_and_paths_are_verified_before_writes(self):
        raw, files = fixture_archive()
        self.assertEqual(delivery.verify_bytes(raw, delivery.sha(raw), 'a'*40)[0]['version'], '0.1.0-rc.1')
        for digest, revision in [('0'*64, 'a'*40), (delivery.sha(raw), 'b'*40)]:
            with self.assertRaises(ValueError):
                delivery.verify_bytes(raw, digest, revision)
        files['controller.py'] += b'changed'
        tampered = archive_files(files)
        with self.assertRaisesRegex(ValueError, 'DIGEST_MISMATCH'):
            delivery.verify_bytes(tampered, delivery.sha(tampered), 'a'*40)
        for name, kind in [('controller/../../escape', tarfile.REGTYPE), ('controller/controller.py', tarfile.SYMTYPE)]:
            extra = tarfile.TarInfo(name)
            extra.type, extra.linkname = kind, '/outside'
            bad = archive_files(fixture_archive()[1], extra)
            with self.assertRaises(ValueError):
                delivery.verify_bytes(bad, delivery.sha(bad), 'a'*40)

    def test_git_source_build_is_reproducible_and_does_not_read_worktree(self):
        with tempfile.TemporaryDirectory() as tmp:
            source = {n: ('fixture source ' + n).encode() for n in delivery.FILES}
            def git(args, **kwargs):
                if 'rev-parse' in args: return ('a'*40 + '\n').encode()
                name = args[-1].split('tools/upgrade-controller/', 1)[1]
                return source[name]
            with patch('delivery.subprocess.check_output', side_effect=git):
                first = delivery.build('/fictional/repo', 'a'*40, '0.1.0-rc.1', Path(tmp)/'one.tar.gz')
                second = delivery.build('/fictional/repo', 'a'*40, '0.1.0-rc.1', Path(tmp)/'two.tar.gz')
            self.assertEqual(first, second)
            self.assertEqual((Path(tmp)/'one.tar.gz').read_bytes(), (Path(tmp)/'two.tar.gz').read_bytes())
            self.assertIn('bootstrapSha256', first)


@unittest.skipUnless(os.name == 'posix' and os.geteuid() == 0, 'Linux root fixture, never the real host layout')
class InstallerTest(unittest.TestCase):
    def setUp(self):
        # /tmp is intentionally rejected by managed ancestor checks; fixture under /root.
        self.temp = tempfile.TemporaryDirectory(prefix='controller-install-fixture-', dir='/root')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.layout = delivery.Layout(self.base)
        self.active = {'yushuhub-upgrade@fixture.service': True}
        self.calls = []
        atomic_json(self.layout.config/'instances/fixture.json', {'instanceId': 'fixture'})
        self.data = self.base/'unchanged-business-data'
        self.data.write_text('fictional new business data')
        self.patcher = patch('delivery.command', side_effect=self.command)
        self.patcher.start(); self.addCleanup(self.patcher.stop)

    def command(self, argv, allow_failure=False):
        self.calls.append(argv)
        if argv[1] == 'is-active': return (0, 'active') if self.active.get(argv[2]) else (3, 'inactive')
        if argv[1] == 'stop': self.active[argv[2]] = False
        if argv[1] == 'start': self.active[argv[2]] = True
        return 0, ''

    def archive(self, version):
        raw, _ = fixture_archive(version)
        path = self.base/(version+'.tar.gz'); path.write_bytes(raw)
        return path, delivery.sha(raw)

    def install(self, version, apply=True):
        path, digest = self.archive(version)
        return delivery.install(path, digest, 'a'*40, apply, self.layout, check=lambda: None)

    def test_plan_no_writes_and_repeat_install_does_not_restart_services(self):
        before = sorted(str(p) for p in self.base.rglob('*'))
        result = self.install('0.1.0-rc.1', False)
        # Only the caller-created archive is new, no managed layout/state.
        self.assertTrue(result['applyRequired'])
        self.assertFalse(self.layout.install.exists())
        self.assertFalse(self.layout.state.exists())
        self.install('0.1.0-rc.1')
        self.calls.clear()
        repeated = self.install('0.1.0-rc.1')
        self.assertTrue(repeated['alreadyInstalled'])
        self.assertFalse(any(a[1] in ('stop', 'start', 'enable', 'disable') for a in self.calls))
        self.assertEqual(self.data.read_text(), 'fictional new business data')

    def test_busy_or_unsettled_business_blocks_install_without_switch(self):
        self.install('0.1.0-rc.1')
        original = delivery.current_target(self.layout)
        with locks(self.layout.state, ['host-cutover']):
            with self.assertRaisesRegex(ValueError, 'TASK_ACTIVE'):
                self.install('0.1.0-rc.2')
        atomic_json(self.layout.state/'instances/fixture/last-request.json', {'stage': 'needs_attention'})
        with self.assertRaisesRegex(ValueError, 'SETTLE_PENDING'):
            self.install('0.1.0-rc.2')
        self.assertEqual(delivery.current_target(self.layout), original)

    def test_failed_service_start_restores_controller_files_and_original_service(self):
        self.install('0.1.0-rc.1')
        original = delivery.current_target(self.layout)
        wrapper = self.layout.cli.read_bytes()
        real_command, failed = self.command, []
        def fail_once(args, allow_failure=False):
            if args[1] == 'start' and not failed:
                failed.append(True)
                raise ValueError('FICTIONAL_START_FAILURE')
            return real_command(args, allow_failure)
        with patch('delivery.command', side_effect=fail_once):
            with self.assertRaisesRegex(ValueError, 'INSTALL_FAILED'):
                self.install('0.1.0-rc.2')
        self.assertEqual(delivery.current_target(self.layout), original)
        self.assertEqual(self.layout.cli.read_bytes(), wrapper)
        self.assertTrue(self.active['yushuhub-upgrade@fixture.service'])
        self.assertEqual(json.loads(self.layout.journal.read_text())['stage'], 'rolled_back')
        self.assertEqual(self.data.read_text(), 'fictional new business data')

    def test_crash_after_switch_recovers_durably_then_explicit_rollback(self):
        self.install('0.1.0-rc.1')
        original = delivery.current_target(self.layout)
        class Crash(BaseException): pass
        def crash(args, allow_failure=False):
            if args[1] == 'daemon-reload': raise Crash()
            return self.command(args, allow_failure)
        with patch('delivery.command', side_effect=crash):
            with self.assertRaises(Crash): self.install('0.1.0-rc.2')
        self.assertEqual(json.loads(self.layout.journal.read_text())['stage'], 'switched')
        with self.assertRaisesRegex(ValueError, 'RECOVERY_REQUIRED'):
            self.install('0.1.0-rc.3')
        self.assertEqual(delivery.recover_install(True, layout=self.layout)['stage'], 'rolled_back')
        self.assertEqual(delivery.current_target(self.layout), original)
        self.install('0.1.0-rc.3')
        self.assertEqual(delivery.recover_install(True, True, self.layout)['stage'], 'rolled_back')
        self.assertEqual(delivery.current_target(self.layout), original)

    def test_altered_existing_release_or_unmanaged_entrypoint_is_rejected(self):
        self.install('0.1.0-rc.1')
        (Path(delivery.current_target(self.layout))/'controller.py').write_text('fictional tamper')
        with self.assertRaisesRegex(ValueError, 'RELEASE_CHANGED'):
            self.install('0.1.0-rc.1')
        self.layout.cli.write_text('#!/bin/sh\n# unrelated fixture tool\n')
        with self.assertRaisesRegex(ValueError, 'ENTRYPOINT_NOT_OWNED'):
            self.install('0.1.0-rc.2')
