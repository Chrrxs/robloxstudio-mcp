# 3.0 tool removals

Version 3.0 removes deprecated aliases instead of keeping a hidden callable
catalog. Update exact-name integrations as follows:

| Removed tool | Replacement |
| --- | --- |
| `start_playtest`, `stop_playtest` | `solo_playtest` with `action: "start"` or `"stop"` |
| `multiplayer_test_start` | `multiplayer_playtest` with `action: "start"` |
| `multiplayer_test_state` | `multiplayer_playtest` with `action: "status"` |
| `multiplayer_test_add_players` | `multiplayer_playtest` with `action: "add_players"` |
| `multiplayer_test_leave_client` | `multiplayer_playtest` with `action: "leave_client"` |
| `multiplayer_test_end` | `multiplayer_playtest` with `action: "end"` |
| `get_file_tree` | `get_project_structure` |
| `search_files` | `search_objects` for instances; `grep_scripts` for source |
| `search_by_property` | `search_objects` with `searchType: "property"` |
| `get_class_info` | `get_roblox_docs` or a `robloxdocs://classes/{className}` resource |
| `export_build`, `create_build`, `generate_build`, `import_build`, `list_library`, `get_build`, `import_scene` | Project-local Luau modules or agent skills backed by `execute_luau` and retained focused tools |
| `search_materials` | Query `MaterialService` with `execute_luau` |
| `smart_duplicate`, `mass_duplicate` | Project-specific cloning or patterned duplication with `execute_luau` |
| `compare_instances` | Read both objects with `get_instance_properties`, or compute a project-specific diff with `execute_luau` |
| `get_services`, `get_instance_children`, `get_descendants` | `get_project_structure` or `search_objects` for ordinary discovery; `execute_luau` for custom traversal |
| `set_property` | `set_properties` with a one-property object |
| `mass_set_property`, `mass_get_property` | A project-specific loop with `execute_luau` |
| `create_object`, `mass_create_objects`, `delete_object`, `clone_object` | Create, destroy, or clone instances with `execute_luau` |
| `set_attribute`, `delete_attribute`, `bulk_set_attributes` | Set or clear attributes with `execute_luau`; `get_attributes` remains for compact reads |
| `get_tags`, `add_tag`, `remove_tag`, `get_tagged` | Use `CollectionService` through `execute_luau` |
| `undo`, `redo` | Use `ChangeHistoryService` through `execute_luau` when a custom workflow needs history control |

The removed names are absent from both `tools/list` and the direct
`/mcp/<tool>` compatibility routes.
