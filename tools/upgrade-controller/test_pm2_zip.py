import hashlib
import json
import os
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch
from pm2_zip import Pm2ZipController, extract_zip
from engine import EngineError
from scan import PATH_DEFAULTS, database_lock_key, read_env
from state import Journal, locks
from test_controller import FakeEngine


class ZipEngine(FakeEngine):
    def source_contract(self, app_root):
        return {'version': json.loads((Path(app_root)/'package.json').read_text())['version'],
                'schemaSha256':'a'*64, 'migrationSha256':'b'*64, 'htmlSha256':'c'*64}

    def run(self, args, timeout=60):
        if args[0] == 'npm':
            if getattr(self, 'npm_failure', False):
                raise EngineError('DEPENDENCY_PREPARATION_FAILED')
            modules = Path(args[-1])/'node_modules'
            modules.mkdir(); (modules/'exact-dependency.txt').write_text('candidate-dependencies')
            return ''
        return super().run(args)

    def verify(self, cfg, release, **kwargs):
        current = json.loads((Path(cfg['appRoot'])/'package.json').read_text())['version']
        if current != release['version']:
            raise EngineError('WRONG_RUNNING_VERSION')
        return super().verify(cfg, release, **kwargs)


class ZipUpgradeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name); self.app = self.root/'app'; self.app.mkdir()
        for name in ('cloud/ai-admin','src/db','web/admin-v2','data','node_modules'):
            (self.app/name).mkdir(parents=True)
        (self.app/'cloud/ai-admin/server.mjs').write_text('// original server')
        (self.app/'web/admin-v2/index.html').write_text('original html')
        (self.app/'src/db/schema.mjs').write_text('// schema')
        (self.app/'package.json').write_text(json.dumps({'name':'agent-ai-admin','version':'1.9.66'}))
        (self.app/'package-lock.json').write_text('{}')
        (self.app/'.env').write_text('AI_DB_NAME=fixture_only\nAI_AUTHORIZATION_MODE=legacy\n')
        (self.app/'node_modules/exact-dependency.txt').write_text('original-dependencies')
        (self.app/'data/ledger.txt').write_text('existing-ledger')
        self.archive = self.root/'package.zip'
        with zipfile.ZipFile(self.archive,'w') as archive:
            archive.writestr('package.json',json.dumps({'name':'agent-ai-admin','version':'1.9.68'}))
            archive.writestr('package-lock.json','{}')
            archive.writestr('cloud/ai-admin/server.mjs','// candidate server')
            archive.writestr('src/db/schema.mjs','// schema')
            archive.writestr('web/admin-v2/index.html','candidate html')
            archive.writestr('web/admin-v2/new-candidate-only.js','// candidate only')
        self.engine = ZipEngine(); self.engine.app_root = str(self.app)
        self.control = Pm2ZipController(self.root/'state',self.root/'config',self.engine)
        self.request = {'appRoot':str(self.app),'archiveFile':str(self.archive),
            'sha256':hashlib.sha256(self.archive.read_bytes()).hexdigest(),'expectedVersion':'1.9.68','operationId':'fictional-upgrade'}
        self.scan = {'issues':[],'pm2':[{'name':'fixture','pid':os.getpid(),'status':'online'}],
            'runningVersion':'1.9.66','port':17199,'paths':[{'key':k,'path':str(self.app/v)} for k,v in PATH_DEFAULTS.items()],
            'databaseLockKey':database_lock_key(read_env(self.app)),'authorizationMode':'legacy-marker','savedAuthorization':False}
        self.addCleanup(patch.stopall)
        patch('pm2_zip.inventory',return_value=self.scan).start()
        patch.object(self.control,'preflight').start()
        patch.object(self.control,'backup_database').start()

    def test_dependency_failure_keeps_exact_old_files_and_running_process(self):
        self.engine.npm_failure = True
        with self.assertRaisesRegex(RuntimeError,'REJECTED'):
            self.control.apply_zip(self.request)
        self.assertNotIn('pm2:stop',self.engine.events)
        self.assertEqual((self.app/'node_modules/exact-dependency.txt').read_text(),'original-dependencies')
        self.assertEqual((self.app/'cloud/ai-admin/server.mjs').read_text(),'// original server')

    def test_health_failure_restores_exact_code_and_dependencies_preserving_new_data(self):
        self.engine.fail_health_once = True
        original = self.engine.verify
        def verify(cfg, release, **kwargs):
            (self.app/'data/new-business-record.txt').write_text('new-record')
            return original(cfg, release, **kwargs)
        with patch.object(self.engine,'verify',side_effect=verify):
            with self.assertRaisesRegex(RuntimeError,'ROLLED_BACK'):
                self.control.apply_zip(self.request)
        self.assertEqual((self.app/'cloud/ai-admin/server.mjs').read_text(),'// original server')
        self.assertEqual((self.app/'node_modules/exact-dependency.txt').read_text(),'original-dependencies')
        self.assertEqual((self.app/'data/new-business-record.txt').read_text(),'new-record')
        self.assertFalse((self.app/'web/admin-v2/new-candidate-only.js').exists())

    def test_interrupted_verification_recovers_from_durable_backup(self):
        class AbruptExit(BaseException): pass
        with patch.object(self.engine,'verify',side_effect=AbruptExit()):
            with self.assertRaises(AbruptExit): self.control.apply_zip(self.request)
        journal = Journal(self.control.directory(str(self.app)))
        self.assertEqual(journal.read()['stage'],'verifying')
        self.assertEqual(self.control.recover_zip(str(self.app))['stage'],'rolled_back')
        self.assertEqual((self.app/'node_modules/exact-dependency.txt').read_text(),'original-dependencies')

    def test_controller_host_lock_blocks_zip_before_any_process_mutation(self):
        with locks(self.control.root,['host-cutover']):
            with self.assertRaisesRegex(RuntimeError,'BUSY'): self.control.apply_zip(self.request)
        self.assertEqual(self.engine.events,[])

    def test_checksum_rejection_keeps_old_service_online(self):
        self.request['sha256'] = '0'*64
        with self.assertRaisesRegex(RuntimeError,'REJECTED'): self.control.apply_zip(self.request)
        self.assertNotIn('pm2:stop',self.engine.events)

    def test_zip_traversal_and_symlinks_are_rejected_before_extracting(self):
        for name, symlink in (('../outside',False),('/outside',False),('src/unsafe',True)):
            with self.subTest(name=name):
                source = self.root/'unsafe.zip'
                with zipfile.ZipFile(source,'w') as archive:
                    item = zipfile.ZipInfo(name)
                    if symlink: item.external_attr = 0o120777 << 16
                    archive.writestr(item,'outside')
                destination = self.root/'unsafe-extract'
                with self.assertRaises(ValueError): extract_zip(source,destination)
                self.assertFalse(destination.exists())
