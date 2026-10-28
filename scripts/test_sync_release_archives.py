import unittest
from unittest.mock import patch
import importlib.util
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location('sync_release_archives_import', Path(__file__).with_name('sync-release-archives.py'))
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
from sync_release_archives_import import archive, version_key


class ArchiveRecoveryTests(unittest.TestCase):
    def test_version_sorting_handles_prereleases_numerically(self):
        values = ['3.0.0-beta.9', '3.0.0', '3.0.0-beta.100', '2.0.0']
        self.assertEqual(sorted(values, key=version_key), ['2.0.0', '3.0.0-beta.9', '3.0.0-beta.100', '3.0.0'])

    def test_legacy_tag_adds_provenance_without_overwriting_existing_wording(self):
        current = {'1.9.56': {'version': '1.9.56', 'releaseNotes': 'Curated notes'}}
        legacy = {'1.9.56': {'version': '1.9.56', 'commit': 'a' * 40, 'repository': 'owner/old-admin', 'gitTag': 'v1.9.56', 'releaseNotes': 'Old notes'}, '1.9.55': {'version': '1.9.55', 'recordType': 'git'}}
        with patch('sync_release_archives_import.collect', side_effect=[current, legacy]):
            rows = archive('admin', ['new', 'old'], [{'version': '1.9.56', 'releaseNotes': 'Official notes'}])
        self.assertEqual(rows[0]['releaseNotes'], 'Official notes')
        self.assertEqual(rows[0]['commit'], 'a' * 40)
        self.assertEqual(rows[0]['gitTag'], 'v1.9.56')
        self.assertEqual(rows[1]['recordType'], 'unpublished')


if __name__ == '__main__':
    unittest.main()
