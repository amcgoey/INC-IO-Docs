# Separation of Drive Content Memory Models

We explicitly separated the Drive infrastructure content API into distinct methods based on memory models: `saveBuffer` (for in-memory manipulation) and `uploadStream` (for untouched pass-through). 

By splitting these instead of providing a single overloaded `upload(content)` method, we force feature adapters to explicitly declare their memory intent. Operations that require the entire file in memory (like modifying PDFs with `pdf-lib`) use the `Buffer` methods, accepting the memory boundary constraints (e.g., up to ~200MB). Operations that just pass files through to Drive (like initial user uploads) use `uploadStream`, minimizing Node's memory footprint. This interface segregation prevents accidental memory bloat from adapters naively loading massive files into buffers when a stream would suffice.
