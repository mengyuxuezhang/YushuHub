import unittest
from unittest.mock import patch
import importlib.util
import sys
from pathlib import Path

spec = importlib.util.spec_from_file_location('sync_release_archives_import', Path(__file__).with_name('sync-release-archives.py'))
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
from sync_release_archives_import import archive, version_key, displayable_git_notes


class ArchiveRecoveryTests(unittest.TestCase):
    def test_recovered_old_records_survive_without_the_old_repository_on_later_runs(self):
        previous = [{'version': '2.0.0-beta.16', 'gitNotes': 'Multi-agent recursive spawn', 'gitNotesSource': 'tag', 'repository': 'owner/old', 'commit': 'c' * 40}]
        with patch('sync_release_archives_import.collect', return_value={}):
            rows = archive('agent', ['current'], [], previous)
        self.assertEqual(rows[0]['version'], previous[0]['version'])
        self.assertEqual(rows[0]['gitNotes'], previous[0]['gitNotes'])

    def test_real_version_messages_are_kept_but_bare_version_labels_are_not(self):
        self.assertEqual(displayable_git_notes('Release v2.0.0-beta.8'), '')
        self.assertEqual(displayable_git_notes('release: prepare desktop 3.0.0-beta.66 [P170-T00]'), '')
        message = 'Release v1.0.9 with local skill creation'
        self.assertEqual(displayable_git_notes(message), message)

    def test_operational_records_and_secret_assignments_are_not_exported(self):
        self.assertEqual(displayable_git_notes('deploy: restart PM2 on production'), '')
        self.assertEqual(displayable_git_notes('fix: password=demo123'), '')
        self.assertEqual(displayable_git_notes('fix: copy /root/private/file'), '')

    def test_different_products_reusing_a_version_do_not_mix_their_messages(self):
        first = {'1.0.0': {'version': '1.0.0', 'commit': 'a' * 40, 'repository': 'owner/current'}}
        other = {'1.0.0': {'version': '1.0.0', 'commit': 'b' * 40, 'repository': 'owner/other', 'gitNotes': 'Unrelated feature', 'gitNotesSource': 'commit'}}
        with patch('sync_release_archives_import.collect', side_effect=[first, other]):
            rows = archive('agent', ['current', 'other'], [])
        self.assertNotIn('gitNotes', rows[0])
        self.assertEqual(rows[0]['commit'], 'a' * 40)

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
