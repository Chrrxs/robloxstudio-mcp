# V3.0 Deprecated Tools & Migrations

Version 3.0 removes deprecated aliases instead of keeping a hidden callable catalog. Update exact-name integrations as follows:

| Removed Tool | V3.0 Replacement |
| --- | --- |
| `start_playtest`, `stop_playtest` | `solo_playtest` using `action: "start"` or `"stop"` |
| `multiplayer_test_start` | `multiplayer_playtest` using `action: "start"` |
| `multiplayer_test_state` | `multiplayer_playtest` using `action: "status"` |
| `multiplayer_test_add_players` | `multiplayer_playtest` using `action: "add_players"` |
| `multiplayer_test_leave_client` | `multiplayer_playtest` using `action: "leave_client"` |
| `multiplayer_test_end` | `multiplayer_playtest` using `action: "end"` |
| `get_selection` | `selection` using `action: "get"` |
| `get_file_tree` | `get_project_structure` |
| `search_files` | `search_objects` for finding instances; `grep_scripts` for finding source text |
| `search_by_property` | `search_objects` using `searchType: "property"` |
| `get_class_info` | `get_roblox_docs` or the standard `robloxdocs://classes/{className}` resource template |
| `export_build`, `create_build`, `generate_build`, `import_build`, `list_library`, `get_build`, `import_scene` | Utilize project-local Luau modules or custom agent skills executed via `execute_luau` in conjunction with retained tools |
| `search_materials` | Query `MaterialService` directly using `execute_luau` |
| `smart_duplicate`, `mass_duplicate` | Implement project-specific cloning or procedural generation using `execute_luau` |
| `compare_instances` | Evaluate both objects independently with `get_instance_properties`, or write a localized diff algorithm using `execute_luau` |
| `get_services`, `get_instance_children`, `get_descendants` | Use `get_project_structure` or `search_objects` for standard hierarchy discovery; use `execute_luau` for complex custom traversals |
| `set_property` | `set_properties` passing a single-key dictionary |
| `mass_set_property`, `mass_get_property` | Write a direct iteration loop via `execute_luau` |
| `create_object`, `mass_create_objects`, `delete_object`, `clone_object` | Use `Instance.new`, `:Destroy()`, or `:Clone()` directly through `execute_luau` |
| `set_attribute`, `delete_attribute`, `bulk_set_attributes` | Modify attributes via `execute_luau`; (`get_attributes` remains available for standard compact reading) |
| `get_tags`, `add_tag`, `remove_tag`, `get_tagged` | Access `CollectionService` directly through `execute_luau` |
| `undo`, `redo` | Manage transactional waypoints via `ChangeHistoryService` using `execute_luau` |

> **Note:** The deprecated names have been entirely purged from both `tools/list` responses and the internal `/mcp/<tool>` HTTP compatibility routes. They will return unknown tool errors if called.
