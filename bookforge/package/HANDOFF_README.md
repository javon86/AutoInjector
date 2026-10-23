# Bookforge final programmer handoff
Source baseline BF-IRB-1.0.0 | Closure revision BF-CLOSURE-1.1

Status: READY_FOR_IMPLEMENTATION. This means the written blueprint and contract artifacts are ready to build from. No Bookforge application has been built or runtime-tested by this handoff.

Start with Specifications/Shared_Contract.pdf, then the relevant separate Bookforge_Set_A_Final.pdf through Bookforge_Set_K_Final.pdf. All 11 retain their own ownership and workspace. Build/Build_Plan.pdf gives the dependency-ordered implementation sequence. Markdown copies are editable and searchable.

Contracts contains 142 operation schema bundles and 142 operation descriptors, shared structures, operation/interface registries and the dependency/stage matrix. Acceptance_Cases contains one concrete structural case file per operation, conditional examples and ten cross-module runtime scenarios. Traceability preserves source hashes, requirement IDs, correction IDs and recorded decisions. History/source_archive.zip contains all six supplied rounds, excluded from current normative instructions.

Requirements for the artifact verifier: Python 3.10+ and jsonschema 4.x. Install with python3 -m pip install -r requirements.txt, then run python3 verify_contracts.py, python3 check_conditions.py and python3 verify_closure.py. The verifier is local/offline after dependencies are installed. Use the delivered case files; --generate-cases is an authoring utility and is not needed by the programmer. Schema/examples pass does not imply persistence, provider or application behavior passed.

Actual implementation acceptance remains FUTURE_RUNTIME_TEST. Build and execute those tests, attach observed evidence, rehearse backup/restore and approve the actual release build before deployment. Begin with the kernel/I/K foundation and first vertical slice listed in the build plan.

Closure corrections are applied inside the separate current module specifications and schemas. Read Shared Contract section 10 for precise replacements, typed imported profiles, artifact representations and event-bundle/queue semantics. Verification contains the applied fix ledger, fixed-rubric independent module reports and final observed checks. History/closure_input.zip preserves this run's untouched input. closure-scorecard.json scores written specification completeness only; runtime/production status remains NOT_EXECUTED. Broad context interfaces are sampled at their permitted endpoint producers; every narrow binding tests every listed producer.

