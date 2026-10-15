# Privacy

QuotaScope binds to loopback and processes allowlisted usage metadata on this Mac. It reads existing local source logs without modifying them. It does not store prompts, message bodies, code, session titles, credentials or full source logs. Provider account identifiers are pseudonymized with a private per-installation identity key.

QuotaScope has no external analytics endpoint. Allowance checks use the installed Codex CLI, which contacts its provider; account sign-in and provider behavior are managed by that CLI. The dashboard loads its assets locally.

Pseudonymous records are still private: timestamps, model/settings metadata, percentages, notes and usage volumes can reveal activity patterns. Exports are not anonymization. Backups contain the database **and identity key**; keep them private. Never publish `.local`, Application Support data, service logs, backups, exports or personal screenshots.

New reads without provider identity are stored separately. No email, credential file or plan-name inference is used to merge accounts. History that lacks attribution is never silently assigned to a new sign-in.
