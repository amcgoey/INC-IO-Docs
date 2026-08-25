# Handlebars for Injection, Not Logic

We are using Handlebars strictly as a template interpolation engine for resolving `CalculatedField`s and `Identity` properties from a `Record` payload.

Handlebars was selected because it is logic-less by design, preventing business rules or complex conditional logic from leaking into configuration schemas. This ensures the domain remains the sole authority on business rules and workflow orchestration. We enforce a strict evaluation order where `CalculatedField`s and `Identity` properties are derived solely from the base payload and cannot reference each other, ensuring a flat, predictable dependency graph. To maintain Hexagonal Architecture, Handlebars is isolated behind a driven port (`TemplateEvaluatorPort`) and operates purely as an infrastructure adapter.
