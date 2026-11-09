"""Fresh installation adoption and cutover policy, without touching a host daemon."""
import copy
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from fresh import checked_template, projection, sha, FreshController, MYSQL_IMAGE
from state import atomic_json


def application():
    instance = 'baota-admin'
    mounts = [{'Type': 'volume', 'Name': 'fiction_' + suffix, 'Source': '/var/lib/docker/volumes/fiction_' + suffix + '/_data',
               'Destination': target, 'RW': rw} for suffix, target, rw in [
                   ('data', '/app/data', True), ('logs', '/app/logs', True), ('published', '/app/published', True), ('secret', '/run/yushuhub', False)]]
    mounts += [{'Type': 'bind', 'Source': '/run/yushuhub-upgrade/' + instance, 'Destination': '/run/yushuhub-upgrade', 'RW': False}]
    return {'Name': '/fiction-admin-1', 'Config': {'Image': 'fiction.invalid/admin@sha256:' + 'a'*64,
        'User': '1000:1000', 'Entrypoint': ['node', 'packaging/container/fresh-entrypoint.mjs'], 'Cmd': None,
        'Env': ['AI_DB_HOST=database', 'AI_DB_USER=yushuhub', 'AI_DB_NAME=yushuhub', 'AI_DB_PASSWORD_FILE=/run/yushuhub/mysql-app',
                'AI_ADMIN_PORT=7077', 'AI_ADMIN_UPGRADE_INSTANCE_ID=' + instance, 'AI_ADMIN_UPGRADE_SOCKET=/run/yushuhub-upgrade/control.sock'], 'Labels': {}},
        'HostConfig': {'ReadonlyRootfs': True, 'Privileged': False, 'CapDrop': ['ALL'], 'CapAdd': [], 'SecurityOpt': ['no-new-privileges:true'],
            'Memory': 512*1024**2, 'RestartPolicy': {'Name': 'unless-stopped'}, 'PortBindings': {'7077/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '7077'}]},
            'Tmpfs': {'/tmp': 'rw,noexec,nosuid,size=64m'}, 'LogConfig': {'Type': 'json-file', 'Config': {'max-size': '10m', 'max-file': '3'}}, 'Init': True},
        'Mounts': mounts, 'NetworkSettings': {'Networks': {'fiction_database': {}, 'fiction_outbound': {}}},
        'State': {'Running': True, 'Health': {'Status': 'healthy'}}}


class PolicyTest(unittest.TestCase):
    def test_imported_compose_and_environment_order_have_stable_contract(self):
        app = application()
        template, port = checked_template(app, 'baota-admin')
        self.assertEqual(port, 7077)
        reordered = copy.deepcopy(app)
        reordered['Config']['Env'].reverse()
        reordered['Mounts'].reverse()
        self.assertEqual(sha(template), sha(projection(reordered)))

    def test_normal_panel_misconfiguration_is_not_silently_adopted(self):
        app = application()
        for mutate in [lambda c: c['HostConfig']['PortBindings']['7077/tcp'][0].update(HostIp='0.0.0.0'),
                       lambda c: c['Mounts'].pop(), lambda c: c['Config'].update(User='root'),
                       lambda c: c['HostConfig'].update(ReadonlyRootfs=False)]:
            changed = copy.deepcopy(app); mutate(changed)
            with self.assertRaises(ValueError):
                checked_template(changed, 'baota-admin')

    def test_fresh_entrypoint_is_not_replaced_by_legacy_start_command(self):
        app = application()
        app['Config']['Entrypoint'] = ['node']
        app['Config']['Cmd'] = ['cloud/ai-admin/server.mjs']
        with self.assertRaisesRegex(ValueError, 'RUNTIME_POLICY'):
            checked_template(app, 'baota-admin')


@unittest.skipUnless(os.name == 'posix' and os.geteuid() == 0, 'root-owned Linux fixture')
class PlanTest(unittest.TestCase):
    def test_schema_change_is_rejected_before_stopping_any_writer(self):
        with tempfile.TemporaryDirectory(dir='/root') as temporary:
            control = FreshController(Path(temporary)/'state', Path(temporary)/'config')
            cfg = {'stateDir': str(Path(temporary)/'state/instances/baota-admin'), '_registrationSha256': 'c'*64}
            old = {'version': '1.9.69-baota.1', 'image': 'fiction.invalid/admin@sha256:'+'a'*64, 'schemaSha256': 'a'*64, 'migrationSha256': 'b'*64}
            target = dict(old, version='1.9.69-baota.2', image='fiction.invalid/admin@sha256:'+'d'*64,
                          supportedFrom=[old['version']], migrationPolicy='same-schema', schemaSha256='0'*64)
            atomic_json(Path(cfg['stateDir'])/'current.json', {'release': old})
            with patch.object(control, 'config', return_value=cfg), patch.object(control, 'release', return_value=target), patch.object(control, 'inspect_runtime') as inspect:
                with self.assertRaisesRegex(ValueError, 'SAME_SCHEMA'):
                    control.plan('baota-admin', 'next')
                inspect.assert_called_once()


if __name__ == '__main__':
    unittest.main()
