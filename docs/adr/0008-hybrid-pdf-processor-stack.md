---
status: accepted
---

# Hybrid PDF Processor Stack

We are using a hybrid technology stack (`pdf-lib` and `pdf.js` via `unpdf`/`pdf-parse`) to handle PDF modification and text extraction entirely in-memory using `Uint8Array`.

We evaluated Google Cloud Document AI and PyMuPDF/mupdf.js for this capability. While PyMuPDF is a powerful all-in-one engine, it relies on an AGPL license which is a commercial constraint. While Google Cloud Document AI provides excellent OCR and layout extraction, it incurs ongoing per-page costs and cannot structurally modify PDFs (insert/extract pages or fill forms), requiring us to still use `pdf-lib`. 

To avoid the licensing constraints and the cloud API latency/cost, we accepted the trade-off of using two separate open-source libraries stitched together behind a unified `PdfProcessor` Facade. `pdf-lib` acts as the structural modifier (page subsets, form fields) and `pdf.js` acts as the text extractor on the resulting subsets. All operations run in-memory to prevent disk I/O bottlenecks on Cloud Run.
