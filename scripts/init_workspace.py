"""Copy only bundled empty templates to a new user directory; never overwrite."""
import argparse,shutil
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);a=p.parse_args()
if a.output.exists() or a.output.is_symlink():raise SystemExit('Destination exists; no overwrite')
root=Path(__file__).resolve().parents[1];shutil.copytree(root/'examples/workspace',a.output)
print(a.output)
