import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from controller import render_runtime_environment
from scan import parse_env_text


LOADER = Path(os.environ.get('AI_UPGRADE_TEST_LOADER_PATH') or Path(__file__).resolve().parent.parent.parent / 'src/config/load-local-env.mjs')


@unittest.skipUnless(shutil.which('node') and LOADER.is_file(), 'Requires Node and the actual application dotenv loader')
class EnvironmentRoundtripTest(unittest.TestCase):
    def test_real_loader_preserves_spaces_quotes_backslashes_hash_equals_empty_and_unicode(self):
        raw = ('\ufeffAI_SPACE_PASSWORD="  fictional password  "\r\n'
               'AI_LITERAL_TOKEN="\'fictional literal quotes\'"\r\n'
               'AI_BACKSLASH="C:\\fictional\\path\\"\n'
               'AI_HASH="fictional#fragment"\nAI_EQUALS="fictional=a=b"\n'
               'AI_EMPTY=""\nAI_BARE_EMPTY=\nAI_ONE_QUOTE=\'\n'
               'AI_DUPLICATE=first\nAI_DUPLICATE=last\n'
               'AI_UNICODE="  \ufefffictional\u2028value  "\n').encode('utf-8')
        with tempfile.TemporaryDirectory() as temporary:
            before, after = Path(temporary)/'before', Path(temporary)/'after'
            before.mkdir();after.mkdir()
            (before/'.env').write_bytes(raw)
            (after/'.env').write_bytes(render_runtime_environment(raw, {'AI_UPLOAD_DIR':'/app/data/fixture path'}))
            script = "const {loadLocalEnvFile}=await import(process.argv[1]);const env={};loadLocalEnvFile(process.argv[2],env);console.log(JSON.stringify(env))"
            def load(root):
                result=subprocess.run(['node','--input-type=module','-e',script,LOADER.as_uri(),str(root)],capture_output=True,text=True,check=True)
                return json.loads(result.stdout)
            original=load(before);converted=load(after)
            converted.pop('AI_UPLOAD_DIR')
            self.assertTrue(original == converted, 'Original and runtime environment values must be identical')
            self.assertTrue(original == parse_env_text(raw.decode('utf-8')), 'Python parser must match the real Node loader')
