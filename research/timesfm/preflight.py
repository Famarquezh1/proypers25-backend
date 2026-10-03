import json, os, platform, shutil, subprocess, sys

report={"shadow_only":True,"no_order_created":True,"python":sys.version,"platform":platform.platform(),"arch":platform.machine()}
try:
 import psutil
 report["ram_gb"]=round(psutil.virtual_memory().total/(1024**3),2)
except Exception:
 report["ram_gb"]=None
report["disk_free_gb"]=round(shutil.disk_usage(os.getcwd()).free/(1024**3),2)
report["compatible_python"]=sys.version_info >= (3,10)
report["resource_gate"]=bool(report["compatible_python"] and report["disk_free_gb"]>=3 and (report["ram_gb"] is None or report["ram_gb"]>=4))
with open("timesfm-preflight.json","w",encoding="utf-8") as f: json.dump(report,f,indent=2)
print(json.dumps(report,indent=2))
if not report["resource_gate"]: sys.exit(2)

# Triggered after workflow registration; read-only research preflight.
