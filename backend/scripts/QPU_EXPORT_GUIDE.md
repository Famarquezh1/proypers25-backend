# QPU read-only export

This helper exports a compact local dataset from `velas_predicciones` for the separate `proypers-qpu-emulator` research repository.

It intentionally:

- reads only from Firestore;
- does not call Binance;
- does not write/update/delete Firestore documents;
- does not touch execution or position collections;
- writes local files only under `backend/qpu_exports/`.

## Run

From the repository root:

```bash
node backend/scripts/export-qpu-dataset.js
```

Optional limit:

```bash
QPU_EXPORT_LIMIT=5000 node backend/scripts/export-qpu-dataset.js
```

On PowerShell:

```powershell
$env:QPU_EXPORT_LIMIT="5000"
node backend/scripts/export-qpu-dataset.js
```

The output is JSONL so it can be consumed directly by the QPU emulator.

The exporter does **not** infer the research label “+3% before -1%” from MFE/MAE, because extrema do not encode threshold order.
