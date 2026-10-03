import json, os, sys, traceback

OUT="timesfm-smoke.json"
report={"shadow_only":True,"no_order_created":True,"model":"google/timesfm-2.5-200m-pytorch","ok":False}
try:
    import numpy as np
    import torch
    import timesfm
    report["python"]=sys.version
    report["torch"]=torch.__version__
    report["timesfm_file"]=getattr(timesfm,"__file__",None)
    torch.set_float32_matmul_precision("high")
    model=timesfm.TimesFM_2p5_200M_torch.from_pretrained(
        "google/timesfm-2.5-200m-pytorch",
        cache_dir=os.environ.get("HF_HOME"),
        force_download=False,
    )
    model.compile(timesfm.ForecastConfig(
        max_context=512,
        max_horizon=128,
        per_core_batch_size=1,
        normalize_inputs=True,
        use_continuous_quantile_head=True,
        force_flip_invariance=True,
        infer_is_positive=True,
        fix_quantile_crossing=True,
    ))
    x=np.linspace(100.0,101.0,256,dtype=np.float32)
    point,q=model.forecast(horizon=16,inputs=[x])
    report.update({"ok":True,"point_shape":list(point.shape),"quantile_shape":list(q.shape),"forecast_first":float(point[0,0]),"forecast_last":float(point[0,-1])})
except Exception as e:
    report["error"]=repr(e)
    report["traceback"]=traceback.format_exc()[-4000:]
finally:
    with open(OUT,"w",encoding="utf-8") as f: json.dump(report,f,indent=2)
    print(json.dumps(report,indent=2))
if not report["ok"]: sys.exit(2)
