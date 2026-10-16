"""Portable read-only/temporary configuration tests; no accounts or external calls."""
import hashlib,json,os,subprocess,sys,tempfile,unittest
from pathlib import Path
ROOT=next(p for p in [Path(__file__).resolve().parent,*Path(__file__).resolve().parents] if (p/'tools/harness/route.rb').is_file())
LOCAL=Path(__file__).resolve().parents[1]
class PortableOpsTests(unittest.TestCase):
 def test_empty_user_workspace_and_offline_page_plan(self):
  with tempfile.TemporaryDirectory() as tmp:
   target=Path(tmp)/'workspace';subprocess.run([sys.executable,str(LOCAL/'scripts/init_workspace.py'),'--output',str(target)],check=True,capture_output=True)
   env={**os.environ,'KUFUCAT_PROJECT_ROOT':str(target)}
   for command in [['ruby',str(ROOT/'tools/harness/validate.rb')],['ruby',str(ROOT/'tools/harness/route.rb'),'engineering'],['node',str(ROOT/'tools/shopify-page-admin/shopify-page-admin.mjs'),'plan',str(LOCAL/'examples/page-spec.json')]]:
    result=subprocess.run(command,env=env,capture_output=True,text=True);self.assertEqual(result.returncode,0,result.stderr)
   before=sorted(str(p.relative_to(target)) for p in target.rglob('*'))
   result=subprocess.run([sys.executable,str(LOCAL/'scripts/init_workspace.py'),'--output',str(target)],capture_output=True)
   self.assertNotEqual(result.returncode,0);self.assertEqual(sorted(str(p.relative_to(target)) for p in target.rglob('*')),before)

 def test_r2_local_plan_and_empty_gate_do_not_authorize_external_actions(self):
  with tempfile.TemporaryDirectory() as tmp:
   sample=Path(tmp)/'synthetic.txt';sample.write_text('Wholly synthetic upload plan')
   env={**os.environ,'R2_ACCOUNT_ID':'0'*32,'R2_BUCKET':'synthetic-bucket','R2_PUBLIC_BASE':'https://example.invalid','KUFUCAT_PROJECT_ROOT':tmp}
   p=subprocess.run(['node',str(ROOT/'03-asset-center/tools/r2_publish/r2_upload.mjs'),'--file',str(sample),'--key','synthetic/example.txt','--expected-sha256',hashlib.sha256(sample.read_bytes()).hexdigest(),'--plan'],env=env,capture_output=True,text=True)
   self.assertEqual(p.returncode,0,p.stderr);result=json.loads(p.stdout);self.assertFalse(result['upload']);self.assertFalse(result['network'])
   uri=(ROOT/'02-social-media-operations/tools/prepublish_check/check.mjs').as_uri()
   script='import {gate} from '+json.dumps(uri)+'; console.log(JSON.stringify(gate([{id:"SYNTHETIC",phase:"review",severity:"required"}],[],"instagram",["review"],"synthetic")));'
   p=subprocess.run(['node','--input-type=module','-e',script],env=env,capture_output=True,text=True)
   self.assertEqual(p.returncode,0,p.stderr);self.assertEqual(json.loads(p.stdout)['result'],'blocked')

if __name__=='__main__':unittest.main()
