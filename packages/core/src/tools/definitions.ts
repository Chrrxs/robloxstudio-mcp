export type ToolCategory = 'read' | 'write';

export interface ToolDefinition {
  name: string;
  description: string;
  category: ToolCategory;
  inputSchema: object;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  // === File & Instance Browsing ===
  {
    name: 'get_file_tree',
    category: 'read',
    description: 'Get instance hierarchy tree from Studio',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Canonical DataModel path (default: game root), such as game.Workspace or game.ServerScriptService[".dir"]'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      }
    }
  },
  {
    name: 'search_files',
    category: 'read',
    description: 'Search instances by name, class, or script content',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Name, class, or code pattern'
        },
        searchType: {
          type: 'string',
          enum: ['name', 'type', 'content'],
          description: 'Search mode (default: name)'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['query']
    }
  },

  // === Place & Service Info ===
  {
    name: 'get_place_info',
    category: 'read',
    description: 'Get place ID, name, and game settings',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      }
    }
  },
  {
    name: 'get_services',
    category: 'read',
    description: 'Get available services and their children',
    inputSchema: {
      type: 'object',
      properties: {
        serviceName: {
          type: 'string',
          description: 'Specific service name'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      }
    }
  },
  {
    name: 'search_objects',
    category: 'read',
    description: 'Find instances by name, class, or properties',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query'
        },
        searchType: {
          type: 'string',
          enum: ['name', 'class', 'property'],
          description: 'Search mode (default: name)'
        },
        propertyName: {
          type: 'string',
          description: 'Property name when searchType is "property"'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['query']
    }
  },

  // === Instance Inspection ===
  {
    name: 'get_instance_properties',
    category: 'read',
    description: 'Get all properties of an instance',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Canonical DataModel path, such as game.Workspace.Part or game.ServerScriptService[".dir"].Main'
        },
        excludeSource: {
          type: 'boolean',
          description: 'For scripts, return SourceLength/LineCount instead of full source (default: false)'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['instancePath']
    }
  },
  {
    name: 'get_instance_children',
    category: 'read',
    description: 'Get children and their class types',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Canonical DataModel path, such as game.Workspace.Part or game.ServerScriptService[".dir"].Main'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['instancePath']
    }
  },
  {
    name: 'search_by_property',
    category: 'read',
    description: 'Find objects with specific property values',
    inputSchema: {
      type: 'object',
      properties: {
        propertyName: {
          type: 'string',
          description: 'Property name'
        },
        propertyValue: {
          type: 'string',
          description: 'Value to match'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['propertyName', 'propertyValue']
    }
  },
  {
    name: 'get_class_info',
    category: 'read',
    description: 'Get properties/methods for a class',
    inputSchema: {
      type: 'object',
      properties: {
        className: {
          type: 'string',
          description: 'Roblox class name'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['className']
    }
  },

  // === Project Structure ===
  {
    name: 'get_project_structure',
    category: 'read',
    description: 'Get full game hierarchy tree. Increase maxDepth (default 3) for deeper traversal.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Canonical DataModel path (default: workspace root)'
        },
        maxDepth: {
          type: 'number',
          description: 'Max traversal depth (default: 3)'
        },
        scriptsOnly: {
          type: 'boolean',
          description: 'Show only scripts (default: false)'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      }
    }
  },

  // === Property Write ===
  {
    name: 'set_property',
    category: 'write',
    description: 'Set a property on an instance',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Canonical DataModel path'
        },
        propertyName: {
          type: 'string',
          description: 'Property name'
        },
        propertyValue: {
          description: 'Value to set (string, number, boolean, or object for Vector3/Color3/UDim2)'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['instancePath', 'propertyName', 'propertyValue']
    }
  },
  {
    name: 'mass_set_property',
    category: 'write',
    description: 'Set a property on multiple instances',
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Canonical DataModel paths'
        },
        propertyName: {
          type: 'string',
          description: 'Property name'
        },
        propertyValue: {
          description: 'Value to set (string, number, boolean, or object for Vector3/Color3/UDim2)'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['paths', 'propertyName', 'propertyValue']
    }
  },
  {
    name: 'mass_get_property',
    category: 'read',
    description: 'Get a property from multiple instances',
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Canonical DataModel paths'
        },
        propertyName: {
          type: 'string',
          description: 'Property name'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['paths', 'propertyName']
    }
  },
  {
    name: 'set_properties',
    category: 'write',
    description: 'Set multiple properties on a single instance in one call.',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Canonical DataModel path'
        },
        properties: {
          type: 'object',
          description: 'Map of property name to value'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['instancePath', 'properties']
    }
  },

  // === Object Creation/Deletion ===
  {
    name: 'create_object',
    category: 'write',
    description: 'Create a new instance. Optionally set properties on creation.',
    inputSchema: {
      type: 'object',
      properties: {
        className: {
          type: 'string',
          description: 'Roblox class name'
        },
        parent: {
          type: 'string',
          description: 'Canonical parent DataModel path'
        },
        name: {
          type: 'string',
          description: 'Optional name'
        },
        properties: {
          type: 'object',
          description: 'Properties to set on creation'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['className', 'parent']
    }
  },
  {
    name: 'mass_create_objects',
    category: 'write',
    description: 'Create multiple instances. Each can have optional properties.',
    inputSchema: {
      type: 'object',
      properties: {
        objects: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              className: {
                type: 'string',
                description: 'Roblox class name'
              },
              parent: {
                type: 'string',
                description: 'Canonical parent DataModel path'
              },
              name: {
                type: 'string',
                description: 'Optional name'
              },
              properties: {
                type: 'object',
                description: 'Properties to set on creation'
              }
            },
            required: ['className', 'parent']
          },
          description: 'Objects to create'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['objects']
    }
  },
  {
    name: 'delete_object',
    category: 'write',
    description: 'Delete an instance',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Canonical DataModel path'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['instancePath']
    }
  },

  // === Duplication ===
  {
    name: 'smart_duplicate',
    category: 'write',
    description: 'Duplicate with naming, positioning, and property variations',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Canonical DataModel path'
        },
        count: {
          type: 'number',
          description: 'Number of duplicates'
        },
        options: {
          type: 'object',
          properties: {
            namePattern: {
              type: 'string',
              description: 'Name pattern ({n} placeholder)'
            },
            positionOffset: {
              type: 'array',
              items: { type: 'number' },
              description: 'X, Y, Z offset per duplicate'
            },
            rotationOffset: {
              type: 'array',
              items: { type: 'number' },
              description: 'X, Y, Z rotation offset'
            },
            scaleOffset: {
              type: 'array',
              items: { type: 'number' },
              description: 'X, Y, Z scale multiplier'
            },
            propertyVariations: {
              type: 'object',
              description: 'Property name to array of values'
            },
            targetParents: {
              type: 'array',
              items: { type: 'string' },
              description: 'Different parent per duplicate'
            }
          }
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['instancePath', 'count']
    }
  },
  {
    name: 'mass_duplicate',
    category: 'write',
    description: 'Batch smart_duplicate operations',
    inputSchema: {
      type: 'object',
      properties: {
        duplications: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              instancePath: {
                type: 'string',
                description: 'Canonical DataModel path'
              },
              count: {
                type: 'number',
                description: 'Number of duplicates'
              },
              options: {
                type: 'object',
                properties: {
                  namePattern: {
                    type: 'string',
                    description: 'Name pattern ({n} placeholder)'
                  },
                  positionOffset: {
                    type: 'array',
                    items: { type: 'number' },
                    description: 'X, Y, Z offset per duplicate'
                  },
                  rotationOffset: {
                    type: 'array',
                    items: { type: 'number' },
                    description: 'X, Y, Z rotation offset'
                  },
                  scaleOffset: {
                    type: 'array',
                    items: { type: 'number' },
                    description: 'X, Y, Z scale multiplier'
                  },
                  propertyVariations: {
                    type: 'object',
                    description: 'Property name to array of values'
                  },
                  targetParents: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Different parent per duplicate'
                  }
                }
              }
            },
            required: ['instancePath', 'count']
          },
          description: 'Duplication operations'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['duplications']
    }
  },

  // === Calculated/Relative Properties ===
  // === Script Read/Write ===
  {
    name: 'get_script_source',
    category: 'read',
    description: 'Get script source. Returns "source" and "numberedSource" (line-numbered). Pass line_range for large scripts; without a range, large scripts are truncated (see the "truncated" flag and "note") to avoid flooding the context.',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Canonical path to a LuaSourceContainer'
        },
        line_range: {
          type: 'string',
          description: 'Line range to return: "start-end" (e.g. "100-200"), open-ended ("100-" or "-200"), or a single line ("42").'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['instancePath']
    }
  },
  {
    name: 'set_script_source',
    category: 'write',
    description: 'Replace entire script source. For partial edits use edit/insert/delete_script_lines.',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Canonical path to a LuaSourceContainer'
        },
        source: {
          type: 'string',
          description: 'New source code'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['instancePath', 'source']
    }
  },
  {
    name: 'edit_script_lines',
    category: 'write',
    description: 'Replace exact text in a script. Without line_range, old_string must match exactly once in the script. Pass line_range as a single line (e.g. "42") to anchor the edit when old_string is ambiguous.',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Canonical path to a LuaSourceContainer'
        },
        old_string: {
          type: 'string',
          description: 'Exact text to find and replace. Must be unique in the script unless line_range is provided.'
        },
        new_string: {
          type: 'string',
          description: 'Replacement text'
        },
        line_range: {
          type: 'string',
          description: 'Optional single line where old_string begins, such as "42". When provided, skips uniqueness check and requires old_string to match starting at that exact line.'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['instancePath', 'old_string', 'new_string']
    }
  },
  {
    name: 'insert_script_lines',
    category: 'write',
    description: 'Insert lines after a given line number (0 = beginning).',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Canonical path to a LuaSourceContainer'
        },
        afterLine: {
          type: 'number',
          description: 'Insert after this line (0 = beginning)'
        },
        newContent: {
          type: 'string',
          description: 'Content to insert'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['instancePath', 'newContent']
    }
  },
  {
    name: 'delete_script_lines',
    category: 'write',
    description: 'Delete a range of lines. line_range is 1-indexed and inclusive.',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Canonical path to a LuaSourceContainer'
        },
        line_range: {
          type: 'string',
          description: 'Line range to delete: "start-end" (e.g. "100-200") or a single line ("42"). Open-ended ranges are not accepted for deletion.'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['instancePath', 'line_range']
    }
  },

  // === Attributes ===
  {
    name: 'set_attribute',
    category: 'write',
    description: 'Set an attribute. Supports primitives, Vector3, Color3, UDim2, BrickColor.',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Canonical DataModel path'
        },
        attributeName: {
          type: 'string',
          description: 'Attribute name'
        },
        attributeValue: {
          description: 'Value (string, number, boolean, or object for Vector3/Color3/UDim2)'
        },
        valueType: {
          type: 'string',
          description: 'Type hint if needed'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['instancePath', 'attributeName', 'attributeValue']
    }
  },
  {
    name: 'get_attributes',
    category: 'read',
    description: 'Get all attributes on an instance',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Canonical DataModel path'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['instancePath']
    }
  },
  {
    name: 'delete_attribute',
    category: 'write',
    description: 'Delete an attribute',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Canonical DataModel path'
        },
        attributeName: {
          type: 'string',
          description: 'Attribute name'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['instancePath', 'attributeName']
    }
  },

  // === Tags ===
  {
    name: 'get_tags',
    category: 'read',
    description: 'Get all tags on an instance',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Canonical DataModel path'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['instancePath']
    }
  },
  {
    name: 'add_tag',
    category: 'write',
    description: 'Add a tag',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Canonical DataModel path'
        },
        tagName: {
          type: 'string',
          description: 'Tag name'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['instancePath', 'tagName']
    }
  },
  {
    name: 'remove_tag',
    category: 'write',
    description: 'Remove a tag',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Canonical DataModel path'
        },
        tagName: {
          type: 'string',
          description: 'Tag name'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['instancePath', 'tagName']
    }
  },
  {
    name: 'get_tagged',
    category: 'read',
    description: 'Get all instances with a specific tag',
    inputSchema: {
      type: 'object',
      properties: {
        tagName: {
          type: 'string',
          description: 'Tag name'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['tagName']
    }
  },

  // === Selection ===
  {
    name: 'get_selection',
    category: 'read',
    description: 'Get all currently selected objects',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      }
    }
  },

  // === Luau Execution ===
  {
    name: 'execute_luau',
    category: 'write',
    description: 'Execute Luau code in plugin context. target="server" and target="client-N" run against live runtime DataModels with PluginSecurity permissions; use eval_*_runtime instead when you need the game Script/LocalScript VM require cache. Use print()/warn() for output. Return value is captured.',
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'Luau code to execute'
        },
        target: {
          type: 'string',
          description: 'Instance target: "edit" (default), "server", "client-1", "client-2", etc.'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['code']
    }
  },
  {
    name: 'eval_server_runtime',
    category: 'write',
    description: 'Execute Luau on the server peer in the running game\'s Script VM (shares require cache with user game scripts, unlike execute_luau target=server which runs in plugin context). Requires a running playtest; the runtime bridge is created automatically inside the play DataModel, including for playtests started manually via the Studio Play button.',
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'Luau code to execute. Use return ... to get a value back.'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['code']
    }
  },
  {
    name: 'eval_client_runtime',
    category: 'write',
    description: 'Execute Luau on a client peer in the running game\'s LocalScript VM (shares require cache with user game scripts, unlike execute_luau target=client-N which runs in plugin context). Requires a running playtest; the runtime bridge is created automatically inside the play DataModel, including for playtests started manually via the Studio Play button.',
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'Luau code to execute. Use return ... to get a value back.'
        },
        target: {
          type: 'string',
          description: 'Client target: "client-1" (default), "client-2", etc.'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['code']
    }
  },

  // === Script Search ===
  {
    name: 'grep_scripts',
    category: 'read',
    description: 'Ripgrep-inspired search across all script sources. Supports literal and Lua pattern matching (with top-level "|" alternation), context lines, early termination, and results grouped by script with line/column numbers.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Search text. Literal by default; with usePattern=true it is a case-sensitive Lua pattern with top-level "|" alternation (e.g. "foo|bar").'
        },
        caseSensitive: {
          type: 'boolean',
          description: 'Literal search case sensitivity (default: false). Lua pattern mode is always case-sensitive; passing false with usePattern=true is rejected.'
        },
        usePattern: {
          type: 'boolean',
          description: 'Use case-sensitive Lua pattern matching instead of literal search (default: false). Supports top-level alternation: "a|b" matches a line containing "a" or "b". Note: Lua patterns are NOT PCRE — use %d/%a/%w classes and ".-" (not ".*?"); ^ $ ( ) . % + - * ? [ ] are magic.'
        },
        contextLines: {
          type: 'number',
          description: 'Number of context lines before/after each match (default: 0)'
        },
        maxResults: {
          type: 'number',
          description: 'Max total matches before stopping (default: 100)'
        },
        maxResultsPerScript: {
          type: 'number',
          description: 'Max matches per script (like rg -m)'
        },
        filesOnly: {
          type: 'boolean',
          description: 'Only return matching script paths, not line details (default: false)'
        },
        path: {
          type: 'string',
          description: 'Subtree to search (e.g. "game.ServerScriptService")'
        },
        classFilter: {
          type: 'string',
          enum: ['Script', 'LocalScript', 'ModuleScript'],
          description: 'Only search scripts of this class type'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['pattern']
    }
  },

  // === Studio Instance Management ===
  {
    name: 'manage_instance',
    category: 'write',
    description: 'Launch, close, inspect, and find revisions for Studio instances. Use action="launch" with source="baseplate" for a blank place, or source="local_file" with local_place_file for a local place; neither uses place_id. Use action="list_place_versions" with place_id to retrieve version numbers through Open Cloud asset versions, then action="launch" with source="place_revision", place_id, and place_version to open an older revision. action="close" can close an MCP-managed instance or an explicitly connected edit instance by instance_id. action="launch" source="published_place" opens the latest published place and is blocked if that place_id is already connected; source="place_revision" is allowed because Studio opens explicit past revisions as anonymous local copies. Requires ROBLOX_OPEN_CLOUD_API_KEY with asset:read for list_place_versions.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['launch', 'close', 'status', 'list_place_versions'],
          description: 'Instance management action.'
        },
        source: {
          type: 'string',
          enum: ['baseplate', 'local_file', 'published_place', 'place_revision'],
          description: 'Required for action="launch". baseplate/local_file do not use place_id; published_place opens the latest place; place_revision opens a specific older version as an anonymous local copy.'
        },
        local_place_file: {
          type: 'string',
          description: 'Required for source="local_file". Path to a .rbxl/.rbxlx place file.'
        },
        place_id: {
          type: 'number',
          description: 'Only used for source="published_place", source="place_revision", and action="list_place_versions". Do not pass for source="baseplate" or source="local_file".'
        },
        place_version: {
          type: 'number',
          description: 'Required for source="place_revision". Use action="list_place_versions" to discover available version numbers.'
        },
        wait_for_connection: {
          type: 'boolean',
          description: 'For action="launch": wait until the MCP plugin connects and return instance_id (default true).'
        },
        timeout_ms: {
          type: 'number',
          description: 'For action="launch": max milliseconds to wait for plugin connection (default 120000).'
        },
        max_page_size: {
          type: 'number',
          description: 'For action="list_place_versions": number of versions to return, clamped to 1-50 (default 10).'
        },
        page_token: {
          type: 'string',
          description: 'For action="list_place_versions": pagination token returned by a prior call.'
        },
        instance_id: {
          type: 'string',
          description: 'For action="close" or action="status": Studio instance to inspect or close. close accepts MCP-managed instances and explicitly connected edit instances.'
        }
      },
      required: ['action']
    }
  },

  // === Playtest ===
  {
    name: 'solo_playtest',
    category: 'write',
    description: 'Start, stop, or inspect a single-player Studio playtest. Use action="start" with mode="play" or "run", action="stop" to end the playtest, and action="status" to inspect active runtime roles. Returns brief lifecycle status only; read script output with get_runtime_logs. Ordinary start/eval/stop workflows do not need reset_simulation_state; use simulation reset only for network or device-simulator tests. For multi-client testing use multiplayer_playtest.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'stop', 'status'],
          description: 'Lifecycle action to run.'
        },
        mode: {
          type: 'string',
          enum: ['play', 'run'],
          description: 'Required for action="start".'
        },
        timeout: {
          type: 'number',
          description: 'Max seconds to wait for start readiness or stop teardown. Defaults: start 60, stop 15.'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['action']
    }
  },
  {
    name: 'set_network_profile',
    category: 'write',
    description: 'Apply simulated network conditions to active playtest client peers via NetworkSettings in plugin context. Requires a running playtest and targets only client peers: pass target="client-1", "client-2", etc., or target="all-clients". Presets: great = 30ms total latency (15ms in / 15ms out), 0ms jitter, 0% packet loss; good = 100ms total latency (50ms in / 50ms out), 10ms jitter, 0% packet loss; poor = 300ms (150ms in / 150ms out), 100ms jitter, 0.5% packet loss. profile="custom" applies only the numeric overrides provided; packet loss values above Roblox\'s 0.5% engine limit are rejected.',
    inputSchema: {
      type: 'object',
      properties: {
        profile: {
          type: 'string',
          enum: ['great', 'good', 'poor', 'custom'],
          description: 'Network condition preset. Presets set all six simulation fields; custom requires overrides.'
        },
        target: {
          type: 'string',
          description: 'Client target: "client-1" (default), "client-2", etc., or "all-clients" to apply to every connected playtest client.'
        },
        overrides: {
          type: 'object',
          additionalProperties: false,
          properties: {
            InboundNetworkMinDelayMs: {
              type: 'number',
              minimum: 0,
              description: 'Server-to-client minimum latency in milliseconds.'
            },
            OutboundNetworkMinDelayMs: {
              type: 'number',
              minimum: 0,
              description: 'Client-to-server minimum latency in milliseconds.'
            },
            InboundNetworkJitterMs: {
              type: 'number',
              minimum: 0,
              description: 'Server-to-client latency jitter in milliseconds.'
            },
            OutboundNetworkJitterMs: {
              type: 'number',
              minimum: 0,
              description: 'Client-to-server latency jitter in milliseconds.'
            },
            InboundNetworkLossPercent: {
              type: 'number',
              minimum: 0,
              maximum: 0.5,
              description: 'Server-to-client packet loss percentage. Roblox engine limit is 0.5%; larger values are rejected.'
            },
            OutboundNetworkLossPercent: {
              type: 'number',
              minimum: 0,
              maximum: 0.5,
              description: 'Client-to-server packet loss percentage. Roblox engine limit is 0.5%; larger values are rejected.'
            }
          },
          description: 'Optional exact NetworkSettings property overrides. For preset profiles, overrides replace preset fields. For custom, only these properties are applied.'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['profile']
    }
  },
  {
    name: 'get_simulation_state',
    category: 'read',
    description: 'Inspect current NetworkSettings and/or StudioDeviceSimulatorService state for edit and connected clients only. Defaults to include="both" and target="edit-and-clients"; server peers are skipped. Use when a task explicitly involves simulated network/device behavior or when you suspect stale simulator state. This is not part of ordinary playtest lifecycle.',
    inputSchema: {
      type: 'object',
      properties: {
        include: {
          type: 'string',
          enum: ['network', 'deviceSimulator', 'both'],
          description: 'Simulation state to inspect: "network", "deviceSimulator", or "both" (default both).'
        },
        target: {
          type: 'string',
          description: 'Simulation target scope: "edit-and-clients" (default), "edit", "all-clients", or a specific "client-N". Server peers are never included.'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      }
    }
  },
  {
    name: 'reset_simulation_state',
    category: 'write',
    description: 'Reset reachable NetworkSettings and/or StudioDeviceSimulatorService state for deterministic network/device tests. Defaults to target="edit-and-clients" and resets both network and device simulator state. Network reset sets all six simulated NetworkSettings fields to 0; device reset calls StopSimulationAsync(). Do not call as routine Studio lifecycle hygiene. Use it after intentionally changing simulation settings, when get_simulation_state shows dirty state, or when a task explicitly requires a clean network/device baseline.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Simulation target scope: "edit-and-clients" (default), "edit", "all-clients", or a specific "client-N". Server peers are skipped.'
        },
        network: {
          type: 'boolean',
          description: 'Reset simulated NetworkSettings fields to 0 (default true).'
        },
        deviceSimulator: {
          type: 'boolean',
          description: 'Stop Studio device simulation with StopSimulationAsync() (default true).'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      }
    }
  },
  {
    name: 'get_device_simulator_state',
    category: 'read',
    description: 'Inspect StudioDeviceSimulatorService state and supported built-in device presets. Defaults to target="edit"; also supports a regular playtest client target such as "client-1". Server targets are not supported. When no simulated device is active, active-only fields are omitted and isSimulating=false.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Device simulator target: "edit" (default) or a regular playtest client like "client-1". Server targets are rejected.'
        },
        deviceId: {
          type: 'string',
          description: 'Optional built-in device preset ID to inspect with GetDeviceInfoAsync.'
        },
        includeDeviceList: {
          type: 'boolean',
          description: 'Include the built-in device preset list from GetDeviceListAsync (default true).'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      }
    }
  },
  {
    name: 'set_device_simulator',
    category: 'write',
    description: 'Set or stop StudioDeviceSimulatorService using built-in device presets only. Defaults to target="edit"; supports "client-N" and "all-clients"; rejects server targets. Applies deviceId first, then orientation, resolution, pixelDensity, and scalingMode overrides.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Device simulator target: "edit" (default), "client-1", "client-2", etc., or "all-clients".'
        },
        deviceId: {
          type: 'string',
          description: 'Built-in device preset ID from get_device_simulator_state.'
        },
        orientation: {
          type: 'string',
          description: 'ScreenOrientation enum name, e.g. "LandscapeRight", "LandscapeLeft", "Portrait", or a full Enum.ScreenOrientation.* string.'
        },
        resolution: {
          type: 'object',
          additionalProperties: false,
          properties: {
            width: {
              type: 'number',
              description: 'Viewport width in pixels.'
            },
            height: {
              type: 'number',
              description: 'Viewport height in pixels.'
            }
          },
          required: ['width', 'height'],
          description: 'Optional resolution override applied after the device preset.'
        },
        pixelDensity: {
          type: 'number',
          description: 'Optional positive pixel density override applied after the device preset.'
        },
        scalingMode: {
          type: 'string',
          description: 'DeviceSimulatorScalingMode enum name, e.g. "ScaleToPhysicalSize", or a full Enum.DeviceSimulatorScalingMode.* string.'
        },
        stopSimulation: {
          type: 'boolean',
          description: 'Stop device simulation. When true, do not pass other simulator setters.'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      }
    }
  },
  {
    name: 'capture_device_matrix',
    category: 'write',
    description: 'Apply up to 6 ordered Studio device simulator settings, capture each viewport screenshot, and restore the previous simulator state by default when the prior state is default or a built-in preset. Custom device persistence is intentionally unsupported. Defaults to target="edit"; supports regular playtest client targets but not server or all-clients targets.',
    inputSchema: {
      type: 'object',
      properties: {
        entries: {
          type: 'array',
          maxItems: 6,
          description: 'Ordered device capture entries. Each entry may set a deviceId and optional simulator overrides before capture.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              label: {
                type: 'string',
                description: 'Optional label included in the screenshot metadata.'
              },
              deviceId: {
                type: 'string',
                description: 'Built-in device preset ID from get_device_simulator_state.'
              },
              orientation: {
                type: 'string',
                description: 'ScreenOrientation enum name or full Enum.ScreenOrientation.* string.'
              },
              resolution: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  width: {
                    type: 'number',
                    description: 'Viewport width in pixels.'
                  },
                  height: {
                    type: 'number',
                    description: 'Viewport height in pixels.'
                  }
                },
                required: ['width', 'height']
              },
              pixelDensity: {
                type: 'number',
                description: 'Optional positive pixel density override.'
              },
              scalingMode: {
                type: 'string',
                description: 'DeviceSimulatorScalingMode enum name or full Enum.DeviceSimulatorScalingMode.* string.'
              }
            }
          }
        },
        target: {
          type: 'string',
          description: 'Device simulator target: "edit" (default) or a regular playtest client such as "client-1". all-clients and server targets are rejected.'
        },
        format: {
          type: 'string',
          enum: ['jpeg', 'png'],
          description: 'Screenshot image format. "jpeg" (default) is compact; "png" is lossless but may exceed inline size limits.'
        },
        quality: {
          type: 'number',
          description: 'JPEG quality 1-100 (default 92). Ignored for png.'
        },
        settleSeconds: {
          type: 'number',
          description: 'Seconds to wait after applying each simulator entry before capturing (default 0.3).'
        },
        restoreAfter: {
          type: 'boolean',
          description: 'Restore the previous default or built-in preset simulator state after the matrix finishes (default true). Custom active devices are not preserved.'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['entries']
    }
  },
  {
    name: 'multiplayer_playtest',
    category: 'write',
    description: 'Start or inspect a StudioTestService multiplayer playtest. Use action="start" with numPlayers and force=true only when you accept that MCP cannot stop it and you must manually close the multiplayer test windows afterward. action="status" inspects state, action="add_players" adds players, and action="leave_client" removes one client. action="end" is disabled for now and returns the StudioTestService:EndTest broken-API reason. Returns brief lifecycle status only; read script output with get_runtime_logs.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'status', 'add_players', 'leave_client', 'end'],
          description: 'Lifecycle action to run.'
        },
        numPlayers: {
          type: 'number',
          description: 'Required for action="start" and action="add_players". Number of client players (1-8).'
        },
        target: {
          type: 'string',
          description: 'Client target for action="leave_client", such as "client-1". Defaults to "client-1".'
        },
        testArgs: {
          description: 'For action="start": JSON-compatible table passed to StudioTestService:GetTestArgs() on server and clients.'
        },
        value: {
          description: 'Ignored while action="end" is disabled.'
        },
        force: {
          type: 'boolean',
          description: 'Required for action="start". Pass true only if you understand StudioTestService:EndTest is broken in this flow and you will manually close the multiplayer test windows.'
        },
        timeout: {
          type: 'number',
          description: 'Max seconds to wait for start peer detection or action completion. Defaults to 30.'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['action']
    }
  },
  {
    name: 'get_runtime_logs',
    category: 'read',
    description: 'Read the in-memory log buffers captured by Studio plugin peers. Each buffer captures ~64 KB of recent LogService output; runtime peers seed from LogService:GetLogHistory() at plugin load so early startup logs emitted before the plugin finishes loading can still be returned, then continue capturing LogService.MessageOut entries. Oldest entries drop when over budget. Entries include capturedBy for the plugin buffer that observed the log. In ordinary Studio play/run sessions, LogService reflects logs across edit/server/client, so script-origin peer is not reliable and entries omit peer. In StudioTestService multiplayer sessions only, peer attribution is reliable and entries also include peer. target=all (default) merges buffers and dedups same-message-and-level entries captured within 2s across different buffers.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Capture buffer to read from: "edit", "server", "client-N", or "all" (default). "all" merges buffers and dedups cross-buffer reflections within a 2s window.'
        },
        since: {
          type: 'number',
          description: 'Return only entries with seq > since. Pass back the previous response\'s nextSince (single target) or perCaptureNextSince entry (target=all) for incremental polling.'
        },
        tail: {
          type: 'number',
          description: 'Return only the last N entries after since/filter is applied.'
        },
        filter: {
          type: 'string',
          description: 'Plain substring matched against each entry\'s message (no pattern semantics; literal text). Applied after since, before tail.'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      }
    }
  },
  {
    name: 'capture_script_profiler',
    category: 'read',
    description: 'Capture one short ScriptProfilerService sample on a running server or client peer and return a compact CPU summary. Use this for Luau/script optimization, not render, physics, networking, or engine microprofiler lanes. Minimal flow: start or reproduce the workload, call capture_script_profiler with target="server" or a specific "client-N", inspect top_functions, patch the suspected hot path, then capture again with the same target/workload/duration_ms/frequency/filter/min_total_us to compare. top_functions is sorted by descending total_us after native/plugin/min/filter exclusions; each row includes rank plus function_index, the 1-based index into the raw Roblox Functions array. Function and node TotalDuration values follow Roblox\'s exported Script Profiler JSON format and are reported in microseconds as total_us. total_us is cumulative profiler TotalDuration during the capture; nested labels/functions can overlap, so do not sum rows as total CPU time. source is the runtime script path reported by Roblox and may need mapping back to editable source with search tools. If function names are too broad, add debug.profilebegin("Area:SpecificStep") / debug.profileend() around suspected code and pass filter="Area:" or another label prefix; matching custom labels appear in debug_labels and top_functions with their script source and no line number. The result echoes effective options in applied and omitted.filtered_out counts rows removed by filter. Keep captures short while actively triggering the behavior; duration_ms defaults to 1000 and is clamped to 100-15000. Pass output_path when you need the raw Roblox Script Profiler JSON for offline comparison or deeper analysis. This tool owns the start/stop/request profiler lifecycle for one capture and does not expose long-lived profiler sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          pattern: '^(server|client-[0-9]+)$',
          description: 'Runtime peer to profile: "server" (default) or "client-N". Use get_connected_instances to discover available runtime roles. target="edit" is invalid because ScriptProfiler captures running code.'
        },
        duration_ms: {
          type: 'number',
          default: 1000,
          minimum: 100,
          maximum: 15000,
          description: 'Sample duration in milliseconds. Defaults to 1000; clamped to 100-15000 so the Studio bridge does not hang on long captures.'
        },
        frequency: {
          type: 'number',
          default: 1000,
          minimum: 1,
          maximum: 10000,
          description: 'ScriptProfiler sampling frequency in samples per second (Hz). Defaults to 1000.'
        },
        max_functions: {
          type: 'number',
          default: 20,
          minimum: 1,
          maximum: 100,
          description: 'Maximum number of top_functions and debug_labels to return. Defaults to 20; clamped to 1-100.'
        },
        min_total_us: {
          type: 'number',
          default: 0,
          minimum: 0,
          description: 'Omit functions below this TotalDuration in microseconds after capture. Defaults to 0.'
        },
        filter: {
          type: 'string',
          description: 'Optional case-insensitive substring matched against function name and source before top_functions are returned. Useful for focusing on one module or debug.profilebegin label prefix.'
        },
        include_native: {
          type: 'boolean',
          description: 'Include native Roblox frames in top_functions. Defaults to false to keep optimization output focused on game Luau and debug labels.'
        },
        include_plugin: {
          type: 'boolean',
          description: 'Include plugin frames in top_functions. Defaults to false because the MCP capture implementation can otherwise add noise.'
        },
        output_path: {
          type: 'string',
          description: 'Optional local path where the MCP server writes the raw Script Profiler JSON. The tool result then includes output_path instead of inlining the raw JSON.'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      }
    }
  },
  {
    name: 'capture_micro_profiler',
    category: 'read',
    description: 'Capture one short Roblox MicroProfiler sample on a running server or client peer using LibMP and return a structured CPU-time attribution dataset. Use this when the performance question is "where is the frame time going?" across scripts, physics, render, network, jobs, scheduler, GC, and engine timers. The primary data is top_groups/top_timers sorted by inclusive_us, exclusive-sorted companion lists, top_threads, top_call_edges, frame_summary, and analysis_window/data_quality so an agent can tell whether a result is steady, spiky, thread-bound, wrapper-heavy, or truncated. For baseline comparison, first capture an empty baseplate/control with the same target/settings and summary_output_path, then capture the game with baseline_path pointing at that saved JSON; saved summaries include a compact comparison_index so baseline_comparison can compare full compact aggregates instead of only visible top rows. Pass baseline inline when the previous capture is already in context. Times are reported in microseconds by converting LibMP MicroProfiler nanosecond ticks; inclusive_us is cumulative nested timer time and can overlap across timers/threads, so do not sum rows as total frame time. *_per_s fields are normalized by analysis_window.analysis_duration_us, not requested duration_ms. pct_of_analyzed_wall can exceed 100 when work overlaps. focus can restrict to script, physics, render, network, or jobs. include_idle defaults false so Sleep/idle noise is omitted. max_events bounds iterator work; event_limit_hit and partial_reasons explain when rankings are useful but partial, so narrow focus/filter or raise max_events for deeper analysis. recommended_tools is intentionally brief; the main purpose is digestible attribution data, not an agent diagnosis.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          pattern: '^(server|client-[0-9]+)$',
          description: 'Runtime peer to profile: "server" (default) or "client-N". Use get_connected_instances to discover available runtime roles.'
        },
        duration_ms: {
          type: 'number',
          default: 1000,
          minimum: 100,
          maximum: 5000,
          description: 'MicroProfiler capture duration in milliseconds. Defaults to 1000; clamped to 100-5000 because decoded event streams are much larger than ScriptProfiler output.'
        },
        focus: {
          type: 'string',
          enum: ['all', 'script', 'physics', 'render', 'network', 'jobs'],
          default: 'all',
          description: 'Optional subsystem focus. Use "all" first for unknown bottlenecks; use a narrower focus after top_groups identifies the area.'
        },
        filter: {
          type: 'string',
          description: 'Optional case-insensitive substring matched against timer name and group after capture. Use to inspect a specific timer family such as Heartbeat, Simulation, $Script, or RbxTransport.'
        },
        max_timers: {
          type: 'number',
          default: 20,
          minimum: 1,
          maximum: 100,
          description: 'Maximum number of top_timers to return. Defaults to 20.'
        },
        max_groups: {
          type: 'number',
          default: 20,
          minimum: 1,
          maximum: 100,
          description: 'Maximum number of top_groups to return. Each group includes its own hot timers. Defaults to 20.'
        },
        max_timers_per_group: {
          type: 'number',
          default: 5,
          minimum: 0,
          maximum: 20,
          description: 'Maximum number of nested top_timers included inside each top_groups row. Defaults to 5; use 0 to omit nested timers.'
        },
        max_related_timers: {
          type: 'number',
          default: 3,
          minimum: 0,
          maximum: 10,
          description: 'Maximum per-row parent, child, and thread context entries. Defaults to 3; use 0 to omit per-row relationship context.'
        },
        min_total_us: {
          type: 'number',
          default: 0,
          minimum: 0,
          description: 'Omit timers below this inclusive_us threshold after idle/focus/filter processing. Defaults to 0.'
        },
        include_idle: {
          type: 'boolean',
          description: 'Include Sleep/idle timers. Defaults to false because idle time usually hides actionable engine work.'
        },
        include_gpu: {
          type: 'boolean',
          description: 'Include GPU thread events when LibMP exposes them. Defaults to false to keep CPU diagnosis focused.'
        },
        max_events: {
          type: 'number',
          default: 250000,
          minimum: 10000,
          maximum: 1000000,
          description: 'Maximum LibMP log events to walk. Defaults to 250000; raise for deeper captures or lower to keep quick iterations snappy.'
        },
        frame_window: {
          type: 'number',
          default: 240,
          minimum: 1,
          maximum: 2000,
          description: 'Analyze only the last N MicroProfiler frames from the snapshot. Defaults to 240.'
        },
        output_path: {
          type: 'string',
          description: 'Optional local path where the MCP server writes the raw MicroProfiler snapshot bytes. The normal response stays summarized.'
        },
        summary_output_path: {
          type: 'string',
          description: 'Optional local path where the MCP server writes the summarized JSON response, including a compact comparison_index. Use this to save an empty-baseplate/control capture for later baseline_path comparison.'
        },
        baseline_path: {
          type: 'string',
          description: 'Optional local path to a prior capture_micro_profiler summarized JSON response. The tool adds baseline_comparison using current minus baseline, normalized by capture duration.'
        },
        baseline: {
          type: 'object',
          description: 'Optional inline prior capture_micro_profiler summarized response to compare against. Prefer baseline_path for large captures.'
        },
        baseline_label: {
          type: 'string',
          description: 'Label used for the baseline side of baseline_comparison, such as "empty_baseplate".'
        },
        current_label: {
          type: 'string',
          description: 'Label used for the current capture side of baseline_comparison, such as the game or scenario name.'
        },
        max_comparison_rows: {
          type: 'number',
          default: 20,
          minimum: 1,
          maximum: 100,
          description: 'Maximum delta rows returned per baseline_comparison section: groups, timers, threads, and call_edges. Defaults to 20.'
        },
        include_comparison_index: {
          type: 'boolean',
          description: 'Include the full compact comparison_index in the normal response. Defaults to false; summary_output_path still saves it for baseline comparison.'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      }
    }
  },
  {
    name: 'breakpoints',
    category: 'write',
    description: 'Manage Studio debugger breakpoints through ScriptDebuggerService. Use this when the user asks to debug with Studio breakpoints. Prefer log breakpoints for agent debugging: pass log_message and let continue_execution default to true, reproduce the issue, then read get_runtime_logs filtered by "Breakpoint". Minimal flow: set a log breakpoint, run or trigger the behavior, call get_runtime_logs with filter="Breakpoint", then call action="clear" to remove MCP-managed breakpoints. Generated breakpoint logs are prefixed with "Breakpoint" plus script_path:line; Studio breakpoint errors also start with "Breakpoint", so this filter captures both successful breakpoint logs and breakpoint-related failures. Set breakpoints on target="edit" before starting a playtest when possible; for an already-running playtest target the runtime DataModel directly, such as "server" or "client-1". Do not set continue_execution=false unless the target DataModel already has a ScriptDebuggerService.OnStopped handler that returns Enum.DebuggerResumeType.Resume for breakpoint/non-exception stops; otherwise the playtest can get stuck and MCP can lose the server/client peers. Minimal OnStopped reference: local sds=game:GetService("ScriptDebuggerService"); sds.OnStopped=function(info) if info.Reason ~= Enum.ScriptStoppedReason.Exception then return Enum.DebuggerResumeType.Resume end print("EXCEPTION:", info.ExceptionText); return Enum.DebuggerResumeType.Resume end. MCP-managed breakpoints persist minimal script_path/line recovery data per place and target so action="list" and action="clear" can find tool-created edit/server/client breakpoints after MCP/plugin reloads. action="clear" removes only breakpoints created through this MCP tool by default; pass clear_all=true only when you intentionally want to clear every Studio breakpoint in the targeted DataModel, including user-created breakpoints. This tool only manages breakpoint lifecycle; it does not pause, resume, step, inspect variables, or install OnStopped callbacks. Requires Studio Debugger Luau API beta enabled.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['set', 'remove', 'clear', 'list'],
          description: 'Breakpoint action to run. set/remove require script_path and line. clear removes MCP-managed breakpoints by default. list returns breakpoints created through this MCP tool in the targeted DataModel.'
        },
        clear_all: {
          type: 'boolean',
          description: 'Only applies to action="clear". Omit or set false to remove only MCP-managed breakpoints tracked by this tool. Set true to call ScriptDebuggerService:ClearBreakpoints() and clear every Studio breakpoint in the targeted DataModel, including user-created breakpoints.'
        },
        script_path: {
          type: 'string',
          description: 'Canonical path to a LuaSourceContainer, for example game.ServerScriptService.Main or game.ServerScriptService[".dir"].ReproScript. Required for set/remove.'
        },
        line: {
          type: 'number',
          description: '1-based line number for set/remove.'
        },
        enabled: {
          type: 'boolean',
          description: 'Whether the breakpoint is enabled when set. Defaults to true.'
        },
        condition: {
          type: 'string',
          description: 'Optional Luau condition expression for set.'
        },
        log_message: {
          type: 'string',
          description: 'Optional Studio breakpoint log expression list for set, such as "\'health\', health". Literal text must be quoted as a Luau string. The tool prefixes this with "Breakpoint" and script_path:line. After reproducing, read get_runtime_logs with filter="Breakpoint" so breakpoint logs and Studio breakpoint errors are both visible.'
        },
        continue_execution: {
          type: 'boolean',
          description: 'Whether the breakpoint should log and continue without pausing. Defaults to true when log_message is provided; otherwise false. Only set false when you have first installed a ScriptDebuggerService.OnStopped handler on the same target that resumes breakpoint/non-exception stops with Enum.DebuggerResumeType.Resume; without that handler the playtest can get stuck and MCP can lose server/client peers.'
        },
        target: {
          type: 'string',
          description: 'Peer to target: "edit" (default), "server", or "client-N". Set edit breakpoints before playtests; target server/client-N for running play DataModels.'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['action']
    }
  },

  // === Multi-Instance ===
  {
    name: 'get_connected_instances',
    category: 'read',
    description: 'List all connected plugin instances with their roles. Use during multi-client playtest to discover server and client instances for targeted commands.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },

  // === Undo/Redo ===
  {
    name: 'undo',
    category: 'write',
    description: 'Undo the last change in Roblox Studio. Uses ChangeHistoryService to reverse the most recent operation.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      }
    }
  },
  {
    name: 'redo',
    category: 'write',
    description: 'Redo the last undone change in Roblox Studio. Uses ChangeHistoryService to reapply the most recently undone operation.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      }
    }
  },

  // === Build Library ===
  {
    name: 'export_build',
    category: 'read',
    description: 'Export a Model/Folder into a compact, token-efficient build JSON format and auto-save it to the local build library. The output contains a palette (unique BrickColor+Material combos mapped to short keys) and compact part arrays with positions normalized relative to the bounding box center. The file is saved to build-library/{style}/{id}.json automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Canonical path to the Model or Folder to export'
        },
        outputId: {
          type: 'string',
          description: 'Build ID for the output (e.g. "medieval/cottage_01"). Defaults to style/instance_name.'
        },
        style: {
          type: 'string',
          enum: ['medieval', 'modern', 'nature', 'scifi', 'misc'],
          description: 'Style category for the build (default: misc)'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['instancePath']
    }
  },
  {
    name: 'create_build',
    category: 'write',
    description: 'Create a new build model from scratch and save it to the library. Define parts using compact arrays [posX, posY, posZ, sizeX, sizeY, sizeZ, rotX, rotY, rotZ, paletteKey, shape?, transparency?]. Palette maps short keys to [BrickColor, Material] pairs. The build is saved and can be referenced by import_build or import_scene.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Build ID including style prefix (e.g. "medieval/torch_01", "nature/bush_small")'
        },
        style: {
          type: 'string',
          enum: ['medieval', 'modern', 'nature', 'scifi', 'misc'],
          description: 'Style category'
        },
        palette: {
          type: 'object',
          description: 'Map of short keys to [BrickColor, Material] or [BrickColor, Material, MaterialVariant] tuples. E.g. {"a": ["Dark stone grey", "Concrete"], "b": ["Brown", "Wood", "MyCustomWood"]}'
        },
        parts: {
          type: 'array',
          description: 'Array of parts. Object format: {position:[x,y,z], size:[x,y,z], rotation:[x,y,z], paletteKey, shape?, transparency?}. Tuple format [posX,posY,posZ,sizeX,sizeY,sizeZ,rotX,rotY,rotZ,paletteKey,shape?,transparency?] also accepted.',
          items: {
            anyOf: [
              {
                type: 'object',
                additionalProperties: false,
                required: ['position', 'size', 'rotation', 'paletteKey'],
                properties: {
                  position: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
                  size: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
                  rotation: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
                  paletteKey: { type: 'string', minLength: 1 },
                  shape: { type: 'string', enum: ['Block', 'Wedge', 'Cylinder', 'Ball', 'CornerWedge'] },
                  transparency: { type: 'number', minimum: 0, maximum: 1 }
                }
              },
              {
                type: 'array',
                minItems: 10,
                items: { anyOf: [{ type: 'number' }, { type: 'string' }] }
              }
            ]
          }
        },
        bounds: {
          type: 'array',
          items: { type: 'number' },
          description: 'Optional bounding box [X, Y, Z]. Auto-computed if omitted.'
        }
      },
      required: ['id', 'style', 'palette', 'parts']
    }
  },
  {
    name: 'generate_build',
    category: 'write',
    description: `Procedurally generate a build via JS code. ALWAYS generate the entire scene in ONE call - never split into multiple small builds. PREFER high-level primitives over manual loops. No comments. No unnecessary variables. Maximize build detail per line.

EDITING: When modifying an existing build, call get_build first to retrieve the original code. Then make ONLY the targeted changes the user requested - do not rewrite unchanged code. Pass the modified code to generate_build.

HIGH-LEVEL (use these first - each replaces 5-20 lines):
  room(x,y,z, w,h,d, wallKey, floorKey?, ceilKey?, wallThickness?) - Complete enclosed room (floor+ceiling+4 walls)
  roof(x,y,z, w,d, style, key, overhang?) - style: "flat"|"gable"|"hip"
  stairs(x1,y1,z1, x2,y2,z2, width, key) - Auto-generates steps between two points
  column(x,y,z, height, radius, key, capKey?) - Cylinder with base+capital
  pew(x,y,z, w,d, seatKey, legKey?) - Bench with seat+backrest+legs
  arch(x,y,z, w,h, thickness, key, segments?) - Curved archway
  fence(x1,z1, x2,z2, y, key, postSpacing?) - Fence with posts+rails

BASIC:
  part(x,y,z, sx,sy,sz, key, shape?, transparency?)
  rpart(x,y,z, sx,sy,sz, rx,ry,rz, key, shape?, transparency?)
  wall(x1,z1, x2,z2, height, thickness, key) - vertical plane from (x1,z1) to (x2,z2)
  floor(x1,z1, x2,z2, y, thickness, key) - horizontal plane at height y, corners (x1,z1)-(x2,z2). NOT fill - only takes 2D corners+y, not 3D points
  fill(x1,y1,z1, x2,y2,z2, key, [ux,uy,uz]?) - 3D volume between two 3D points
  beam(x1,y1,z1, x2,y2,z2, thickness, key)

IMPORTANT: Palette keys must match exactly. Use only keys defined in your palette object, not color names.
CUSTOM MATERIALS: Use search_materials to find MaterialVariant names, then reference them as the 3rd palette element: {"a": ["Color", "BaseMaterial", "VariantName"]}.

REPETITION:
  row(x,y,z, count, spacingX, spacingZ, fn(i,cx,cy,cz))
  grid(x,y,z, countX, countZ, spacingX, spacingZ, fn(ix,iz,cx,cy,cz))

Shapes: Block(default), Wedge, Cylinder, Ball, CornerWedge. Max 10000 parts. Math and rng() available.
CYLINDER AXIS: Roblox cylinders extend along the X axis. For upright cylinders, use size (height, diameter, diameter) with rz=90. The column() primitive handles this automatically.

EXAMPLE - compact cabin (17 lines):
room(0,0,0,8,4,6,"a","b","a")
roof(0,4,0,8,6,"gable","c")
wall(-4,0,-2,4,0,-2,4,1,"a")
part(0,2,3,3,3,0.3,"a","Block",0.4)
row(-2,0,-1,3,0,2,(i,cx,cy,cz)=>{pew(cx,0,cz,3,2,"d")})
column(-3,0,-2,4,0.5,"a","b")
column(3,0,-2,4,0.5,"a","b")
part(0,2,0,2,1,1,"b")`,
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Build ID including style prefix (e.g. "medieval/church_01")'
        },
        style: {
          type: 'string',
          enum: ['medieval', 'modern', 'nature', 'scifi', 'misc'],
          description: 'Style category'
        },
        palette: {
          type: 'object',
          description: 'Map of short keys to [BrickColor, Material] or [BrickColor, Material, MaterialVariant] tuples. E.g. {"a": ["Dark stone grey", "Cobblestone"], "b": ["Brown", "WoodPlanks", "MyCustomWood"]}. MaterialVariant is optional - use it to reference custom materials from MaterialService.'
        },
        code: {
          type: 'string',
          description: 'JavaScript code using the primitives above to generate parts procedurally'
        },
        seed: {
          type: 'number',
          description: 'Optional seed for deterministic rng() output (default: 42)'
        }
      },
      required: ['id', 'style', 'palette', 'code']
    }
  },
  {
    name: 'import_build',
    category: 'write',
    description: 'Import a build into Roblox Studio. Accepts either a full build data object OR a library ID string (e.g. "medieval/church_01") to load from the build library. When using generate_build or create_build, pass the build ID string instead of the full data.',
    inputSchema: {
      type: 'object',
      properties: {
        buildData: {
          description: 'Either a build data object (with palette, parts, etc.) OR a library ID string (e.g. "medieval/church_01") to load from the build library'
        },
        targetPath: {
          type: 'string',
          description: 'Canonical parent DataModel path where the model will be created'
        },
        position: {
          type: 'array',
          items: { type: 'number' },
          description: 'World position offset [X, Y, Z]'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['buildData', 'targetPath']
    }
  },
  {
    name: 'list_library',
    category: 'read',
    description: 'List available builds in the local build library. Returns build IDs, styles, bounds, and part counts. Optionally filter by style.',
    inputSchema: {
      type: 'object',
      properties: {
        style: {
          type: 'string',
          enum: ['medieval', 'modern', 'nature', 'scifi', 'misc'],
          description: 'Filter by style category'
        }
      }
    }
  },
  {
    name: 'search_materials',
    category: 'read',
    description: 'Search for MaterialVariant instances in MaterialService by name. Use this to find custom materials before using them in generate_build or create_build palettes. Returns material names and their base material types.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query to match against material names (case-insensitive). Leave empty to list all.'
        },
        maxResults: {
          type: 'number',
          description: 'Max results to return (default: 50)'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      }
    }
  },
  {
    name: 'get_build',
    category: 'read',
    description: 'Get a build from the library by ID. Returns metadata, palette, and generator code (if the build was created with generate_build). IMPORTANT: When the user asks to modify an existing build, ALWAYS call get_build first to retrieve the original code, then make targeted edits to only the relevant lines, and call generate_build with the modified code. Never rewrite the entire code from scratch - only change what the user asked to change.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Build ID (e.g. "medieval/church_01")'
        }
      },
      required: ['id']
    }
  },
  {
    name: 'import_scene',
    category: 'write',
    description: 'Import a full scene layout. Provide a scene with model references (resolved from library) and placement data. Each model is placed at the specified position/rotation. Can also include inline custom builds.',
    inputSchema: {
      type: 'object',
      properties: {
        sceneData: {
          type: 'object',
          description: 'Scene layout object with: models (map of key to library build ID), place (array of [key, position, rotation?]), and optional custom (array of inline build objects with name, position, palette, parts)',
          properties: {
            models: {
              type: 'object',
              description: 'Map of short keys to library build IDs (e.g. {"A": "medieval/cottage_01"})'
            },
            place: {
              type: 'array',
              description: 'Array of placements. Preferred format: {modelKey, position:[x,y,z], rotation?:[x,y,z]}. Legacy tuple format [modelKey, [x,y,z], [rotX?,rotY?,rotZ?]] is also accepted.',
              items: {
                anyOf: [
                  {
                    type: 'object',
                    additionalProperties: false,
                    required: ['modelKey', 'position'],
                    properties: {
                      modelKey: {
                        type: 'string'
                      },
                      position: {
                        type: 'array',
                        items: { type: 'number' }
                      },
                      rotation: {
                        type: 'array',
                        items: { type: 'number' }
                      }
                    }
                  },
                  {
                    type: 'array',
                    items: {
                      anyOf: [
                        {
                          type: 'string'
                        },
                        {
                          type: 'array',
                          items: { type: 'number' }
                        }
                      ]
                    }
                  }
                ]
              }
            },
            custom: {
              type: 'array',
              description: 'Array of inline custom builds with {n: name, o: [x,y,z], palette: {...}, parts: [...]}',
              items: { type: 'object' }
            }
          }
        },
        targetPath: {
          type: 'string',
          description: 'Canonical parent DataModel path for the scene (default: game.Workspace)'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['sceneData']
    }
  },

  // === Asset Tools ===
  {
    name: 'search_assets',
    category: 'read',
    description: 'Search the Creator Store (Roblox marketplace) for assets by type and keywords. Requires ROBLOX_OPEN_CLOUD_API_KEY env var (no cookie auth for this endpoint).',
    inputSchema: {
      type: 'object',
      properties: {
        assetType: {
          type: 'string',
          enum: ['Audio', 'Model', 'Decal', 'Plugin', 'MeshPart', 'Video', 'FontFamily'],
          description: 'Type of asset to search for'
        },
        query: {
          type: 'string',
          description: 'Search keywords'
        },
        maxResults: {
          type: 'number',
          description: 'Max results to return (default: 25)'
        },
        sortBy: {
          type: 'string',
          enum: ['Relevance', 'Trending', 'Top', 'AudioDuration', 'CreateTime', 'UpdatedTime', 'Ratings'],
          description: 'Sort order (default: Relevance)'
        },
        verifiedCreatorsOnly: {
          type: 'boolean',
          description: 'Only show assets from verified creators (default: false)'
        }
      },
      required: ['assetType']
    }
  },
  {
    name: 'get_asset_details',
    category: 'read',
    description: 'Get detailed marketplace metadata for a specific asset. Uses ROBLOX_OPEN_CLOUD_API_KEY or falls back to ROBLOSECURITY cookie (own assets only).',
    inputSchema: {
      type: 'object',
      properties: {
        assetId: {
          type: 'number',
          description: 'The Roblox asset ID'
        }
      },
      required: ['assetId']
    }
  },
  {
    name: 'get_asset_thumbnail',
    category: 'read',
    description: 'Get the thumbnail image for an asset as base64 PNG, suitable for vision LLMs. Thumbnails API is public but asset validation uses ROBLOX_OPEN_CLOUD_API_KEY.',
    inputSchema: {
      type: 'object',
      properties: {
        assetId: {
          type: 'number',
          description: 'The Roblox asset ID'
        },
        size: {
          type: 'string',
          enum: ['150x150', '420x420', '768x432'],
          description: 'Thumbnail size (default: 420x420)'
        }
      },
      required: ['assetId']
    }
  },
  {
    name: 'insert_asset',
    category: 'write',
    description: 'Insert a Roblox asset into Studio by loading it via AssetService and parenting it to a target location. Optionally set position.',
    inputSchema: {
      type: 'object',
      properties: {
        assetId: {
          type: 'number',
          description: 'The Roblox asset ID to insert'
        },
        parentPath: {
          type: 'string',
          description: 'Canonical parent DataModel path (default: game.Workspace)'
        },
        position: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            z: { type: 'number' }
          },
          description: 'Optional world position to place the asset'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['assetId']
    }
  },
  {
    name: 'generate_model',
    category: 'write',
    description: 'Generate a Roblox Model with GenerationService:GenerateModelAsync from a prompt, a Roblox image asset ID, a PNG reference image, or prompt+image. The tool only creates and stages the generated model under ServerStorage; use ordinary instance tools afterward if you want to parent, position, scale, anchor, or integrate it into the world. Provide exactly one of image_path, image_base64, or image_asset_id when using an image. Roblox requires image inputs as rbxassetid/rbxasset URIs, so image_path and image_base64 are uploaded as Roblox Decal/Image assets first using configured upload credentials; pass image_asset_id to use an existing asset without uploading. schema defaults to Body1 for a single mesh output; use schema_groups for custom segmentation such as Body plus named wheel/finger/limb groups. Output is intentionally brief: success returns only success and modelPath; failure returns only success and error.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Text prompt describing the model to generate. Required unless an image input is provided.'
        },
        image_path: {
          type: 'string',
          description: 'Local PNG file path for a visual reference image. Uploaded as a Roblox Decal/Image asset before generation. Mutually exclusive with image_base64 and image_asset_id.'
        },
        image_base64: {
          type: 'string',
          description: 'Base64-encoded PNG reference image bytes. Requires image_mime_type="image/png" and is uploaded as a Roblox Decal/Image asset before generation. Mutually exclusive with image_path and image_asset_id.'
        },
        image_mime_type: {
          type: 'string',
          enum: ['image/png'],
          description: 'Required when image_base64 is provided. Currently only image/png is supported.'
        },
        image_asset_id: {
          type: 'number',
          description: 'Existing Roblox image asset ID used as a visual reference. Mutually exclusive with image_path and image_base64.'
        },
        schema: {
          type: 'string',
          enum: ['Body1', 'Car5'],
          default: 'Body1',
          description: 'Built-in GenerationService schema. Defaults to Body1 for one generated mesh. Use Car5 only for a five-part vehicle chassis.'
        },
        schema_groups: {
          type: 'array',
          items: { type: 'string' },
          description: 'Custom SchemaDefinition.Groups part names that define generated model segmentation, such as ["Body","Front Left Wheel","Front Right Wheel","Rear Left Wheel","Rear Right Wheel"]. Mutually exclusive with schema.'
        },
        name: {
          type: 'string',
          description: 'Optional name for the generated Model under game.ServerStorage.__MCPGeneratedModels.'
        },
        size: {
          type: 'object',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            z: { type: 'number' }
          },
          description: 'Optional approximate generated object size. GenerationService may not match it exactly.'
        },
        max_triangles: {
          type: 'number',
          minimum: 1,
          description: 'Optional maximum triangle count. Lower values produce more faceted/low-poly results.'
        },
        generate_textures: {
          type: 'boolean',
          description: 'Whether GenerationService should generate textures. Defaults to Roblox behavior (true).'
        },
        timeout_ms: {
          type: 'number',
          minimum: 1,
          maximum: 300000,
          default: 120000,
          description: 'Maximum MCP bridge wait for this generation request. Defaults to 120000ms.'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      }
    }
  },
  {
    name: 'preview_asset',
    category: 'read',
    description: 'Preview a Roblox asset without permanently inserting it. Loads the asset, builds a hierarchy tree with properties and summary stats, then destroys it. Useful for inspecting asset contents before insertion.',
    inputSchema: {
      type: 'object',
      properties: {
        assetId: {
          type: 'number',
          description: 'The Roblox asset ID to preview'
        },
        includeProperties: {
          type: 'boolean',
          description: 'Include detailed properties for each instance (default: true)'
        },
        maxDepth: {
          type: 'number',
          description: 'Max hierarchy traversal depth (default: 10)'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['assetId']
    }
  },
  {
    name: 'upload_asset',
    category: 'write',
    description: 'Upload any supported asset type to Roblox: Audio (mp3/ogg/wav/flac), Decal (png/jpg/bmp/tga), Model (fbx/gltf/glb/rbxm/rbxmx), Animation (rbxm/rbxmx), or Video (mp4/mov). Decal supports ROBLOSECURITY cookie auth or ROBLOX_OPEN_CLOUD_API_KEY. All other types require Open Cloud API key with asset:write scope + creator ID. Audio: max 7 min, 100 uploads/month (ID-verified). Video: max 5 min, requires 13+ ID-verified.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Absolute path to the file on disk'
        },
        assetType: {
          type: 'string',
          enum: ['Audio', 'Decal', 'Model', 'Animation', 'Video'],
          description: 'Type of asset to upload. Must match the file format.'
        },
        displayName: {
          type: 'string',
          description: 'Display name for the asset (max 50 characters)'
        },
        description: {
          type: 'string',
          description: 'Description for the asset (default: empty string)'
        },
        userId: {
          type: 'string',
          description: 'Roblox user ID for the asset creator. Overrides ROBLOX_CREATOR_USER_ID env var.'
        },
        groupId: {
          type: 'string',
          description: 'Roblox group ID for the asset creator. Overrides ROBLOX_CREATOR_GROUP_ID env var. Takes precedence over userId if both provided.'
        }
      },
      required: ['filePath', 'assetType', 'displayName']
    }
  },
  {
    name: 'capture_screenshot',
    category: 'read',
    description: 'Capture the Roblox Studio viewport at native resolution and return it as an image, plus a text line stating the exact pixel dimensions. Works in Edit mode and regular playtests (auto-detects a running client and captures the live play viewport). StudioTestService multiplayer client screenshots are currently blocked by Roblox temporary-texture process scoping; the tool returns a clear error in that case. The returned image is never downscaled, so its pixel grid is exactly the coordinate space simulate_mouse_input uses — read click positions straight off this image. For reading fine text/UI, use format="png" (lossless) or a higher quality; enlarging the Studio window raises resolution. Requires EditableImage API enabled (Game Settings > Security > "Allow Mesh / Image APIs") and the window to be visible.',
    inputSchema: {
      type: 'object',
      properties: {
        format: {
          type: 'string',
          enum: ['jpeg', 'png'],
          description: 'Image format. "jpeg" (default) is compact and crisp at high quality. "png" is lossless — best for reading dense text/UI, but larger (a busy 3D scene may be big).'
        },
        quality: {
          type: 'number',
          description: 'JPEG quality 1-100 (default 92). Higher = sharper text, larger size. Ignored for png.'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
    }
  },

  // === Input Simulation ===
  {
    name: 'simulate_mouse_input',
    category: 'write',
    description: 'Simulate a mouse click in the running game via UserInputService:CreateVirtualInput. Use during a playtest to click UI buttons, interact with objects, or aim. Fires real UserInputService input and activates GUI buttons. Coordinates are viewport pixels matching capture_screenshot (top-left is 0,0) — take a screenshot first to find positions. Auto-targets the running client; only works during a playtest. Note: only click/mouseDown/mouseUp are supported (the API has no mouse-move or scroll).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['click', 'mouseDown', 'mouseUp'],
          description: 'Mouse action. "click" does mouseDown + short delay + mouseUp.'
        },
        x: {
          type: 'number',
          description: 'Viewport pixel X coordinate (as seen in capture_screenshot)'
        },
        y: {
          type: 'number',
          description: 'Viewport pixel Y coordinate (as seen in capture_screenshot)'
        },
        button: {
          type: 'string',
          enum: ['Left', 'Right', 'Middle'],
          description: 'Mouse button (default: Left)'
        },
        target: {
          type: 'string',
          description: 'Instance target. Defaults to the running playtest client (client-1) when present, else "edit". Override with "server", "client-2", etc.'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['action', 'x', 'y']
    }
  },
  {
    name: 'simulate_keyboard_input',
    category: 'write',
    description: 'Simulate keyboard input in the running game via UserInputService:CreateVirtualInput. Use during a playtest for character movement (W/A/S/D walks at full WalkSpeed with player controls intact), jumping (Space), interactions (E), or any key-driven action. Drives the real input pipeline so game scripts and control modules respond. For sustained movement use action="press" to hold and "release" to let go. Pass "text" instead of keyCode to type a string into the focused TextBox. Auto-targets the running client; only works during a playtest.',
    inputSchema: {
      type: 'object',
      properties: {
        keyCode: {
          type: 'string',
          description: 'Enum.KeyCode name: "W", "A", "S", "D", "Space", "E", "F", "LeftShift", "LeftControl", "Return", "Tab", "Escape", "One", "Two", etc. Omit if using "text".'
        },
        action: {
          type: 'string',
          enum: ['press', 'release', 'tap'],
          description: '"tap" (default) = press + wait + release. "press" = key down only. "release" = key up only.'
        },
        duration: {
          type: 'number',
          description: 'Hold duration in seconds for "tap" action (default: 0.1). Use longer values for sustained input like walking.'
        },
        text: {
          type: 'string',
          description: 'Type this string into the currently focused TextBox (uses SendTextInput). When provided, keyCode/action are ignored.'
        },
        target: {
          type: 'string',
          description: 'Instance target. Defaults to the running playtest client (client-1) when present, else "edit". Override with "server", "client-2", etc.'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      }
    }
  },

  // === Instance Operations ===
  {
    name: 'clone_object',
    category: 'write',
    description: 'Clone an instance to a new parent location. Creates a deep copy of the instance and all its descendants.',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Canonical path of the instance to clone'
        },
        targetParentPath: {
          type: 'string',
          description: 'Canonical path of the parent to place the clone under'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['instancePath', 'targetParentPath']
    }
  },
  // === Descendants & Comparison ===
  {
    name: 'get_descendants',
    category: 'read',
    description: 'Get all descendants of an instance recursively with depth info. More efficient than repeated get_instance_children calls.',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Canonical root DataModel path'
        },
        maxDepth: {
          type: 'number',
          description: 'Maximum recursion depth (default: 10)'
        },
        classFilter: {
          type: 'string',
          description: 'Only include instances of this class (uses IsA, so "BasePart" matches Part, MeshPart, etc.)'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['instancePath']
    }
  },
  {
    name: 'compare_instances',
    category: 'read',
    description: 'Diff two instances by comparing their properties. Useful for debugging why a duplicate behaves differently.',
    inputSchema: {
      type: 'object',
      properties: {
        instancePathA: {
          type: 'string',
          description: 'First canonical DataModel path'
        },
        instancePathB: {
          type: 'string',
          description: 'Second canonical DataModel path'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['instancePathA', 'instancePathB']
    }
  },
  // === Bulk Attributes ===
  {
    name: 'bulk_set_attributes',
    category: 'write',
    description: 'Set multiple attributes on an instance in a single call. More efficient than repeated set_attribute calls.',
    inputSchema: {
      type: 'object',
      properties: {
        instancePath: {
          type: 'string',
          description: 'Canonical DataModel path'
        },
        attributes: {
          type: 'object',
          description: 'Map of attribute names to values. Supports Vector3, Color3, UDim2 via _type convention.'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['instancePath', 'attributes']
    }
  },

  // === Per-peer memory breakdown ===
  {
    name: 'get_memory_breakdown',
    category: 'read',
    description: 'Read per-category memory usage by iterating Enum.DeveloperMemoryTag and calling Stats:GetMemoryUsageMbForTag per item (workaround for Stats:GetMemoryUsageMbAllCategories being gated by Capabilities: InternalTest and not callable from plugin context), plus Stats:GetTotalMemoryUsageMb for the rollup. target="all" (default) returns { peer: { total_mb, categories, timestamp } } for every connected peer except edit-proxy; single-peer targets return that peer\'s object directly. Optional tags whitelist filters to only those DeveloperMemoryTag entries; unknown tags come back with value 0 and are listed in unknown_tags so cross-version drift doesn\'t error. timestamp is Unix milliseconds (DateTime.now().UnixTimestampMillis). Per-peer MemoryTrackingEnabled=false surfaces as { error } on that peer only.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Peer to read from: "edit", "server", "client-N", or "all" (default).'
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional DeveloperMemoryTag whitelist. Unknown tag names return 0 + unknown_tags list.'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      }
    }
  },
  {
    name: 'get_scene_analysis',
    category: 'read',
    description: 'Read Roblox SceneAnalysisService data for attribution-focused performance analysis. Complements get_memory_breakdown: returns compact top-N entries for instance composition, script memory, unparented instances, triangle composition, animation memory, and audio memory. Requires the Studio Scene Analysis beta feature; if disabled, returns scene_analysis_not_enabled with betaFeatureRequired=true. target="all" (default) returns per-peer data; single-peer targets return that peer directly. raw=true includes the full nested Scene Analysis tree.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['all', 'instance_composition', 'script_memory', 'unparented_instances', 'triangle_composition', 'animation_memory', 'audio_memory'],
          description: 'Scene analysis mode to read. Defaults to "all".'
        },
        target: {
          type: 'string',
          description: 'Peer to read from: "edit", "server", "client-N", or "all" (default).'
        },
        topN: {
          type: 'number',
          minimum: 1,
          maximum: 100,
          description: 'Number of flattened top entries to include per mode. Defaults to 10; plugin clamps to 1-100.'
        },
        raw: {
          type: 'boolean',
          description: 'Include the full nested SceneAnalysisService tree in each mode result. Defaults to false.'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      }
    }
  },

  // === SerializationService round-trip ===
  {
    name: 'export_rbxm',
    category: 'read',
    description: 'Serialize one or more instances to a .rbxm file on disk via SerializationService:SerializeInstancesAsync (engine v668+, PluginSecurity). Throws if any path resolves to nil, a service, or a non-creatable instance.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Canonical DataModel paths to serialize (e.g. ["game.Workspace.TestRig", "game.ServerStorage.Templates.NPC"])'
        },
        output_path: {
          type: 'string',
          description: 'Absolute filesystem path where the .rbxm should be written'
        },
        target: {
          type: 'string',
          enum: ['edit', 'server'],
          description: 'Which DataModel to read from (default: "edit"). "server" serializes live runtime state during a playtest.'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['instance_paths', 'output_path']
    }
  },
  {
    name: 'import_rbxm',
    category: 'write',
    description: 'Deserialize a .rbxm via SerializationService:DeserializeInstancesAsync (engine v668+, PluginSecurity) and parent the resulting instances under parent_path. All-or-nothing parenting: if any single instance fails to parent, every already-parented sibling is unparented and the call errors. Wrapped in ChangeHistoryService for edit target so one Ctrl+Z reverses the whole import.',
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          type: 'object',
          description: 'Exactly one of { path }, { url }, or { base64 }. path = read from local disk; url = http(s) only, fetched by the MCP server process, capped at 50 MiB; base64 = raw bytes inline.',
          properties: {
            path: { type: 'string' },
            url: { type: 'string' },
            base64: { type: 'string' }
          },
          oneOf: [
            { required: ['path'] },
            { required: ['url'] },
            { required: ['base64'] }
          ]
        },
        parent_path: {
          type: 'string',
          description: 'Canonical DataModel path of the Instance to parent imported instances under (e.g. "game.ServerStorage.Imported")'
        },
        target: {
          type: 'string',
          enum: ['edit', 'server'],
          description: 'Which DataModel to import into (default: "edit"). "server" parents into the live play-server DM.'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['source', 'parent_path']
    }
  },

  // === Find and Replace ===
  {
    name: 'find_and_replace_in_scripts',
    category: 'write',
    description: 'Find and replace text across all scripts in the game. Supports literal and Lua pattern matching. Use dryRun to preview changes before applying. Pairs with grep_scripts for search-only operations.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Text or Lua pattern to find'
        },
        replacement: {
          type: 'string',
          description: 'Replacement text. When usePattern is true, supports Lua captures (%1, %2, etc.).'
        },
        caseSensitive: {
          type: 'boolean',
          description: 'Case-sensitive matching (default: false). Must be true when usePattern is true.'
        },
        usePattern: {
          type: 'boolean',
          description: 'Use Lua pattern matching instead of literal (default: false). Requires caseSensitive: true.'
        },
        path: {
          type: 'string',
          description: 'Limit scope to a subtree (e.g. "game.ServerScriptService")'
        },
        classFilter: {
          type: 'string',
          enum: ['Script', 'LocalScript', 'ModuleScript'],
          description: 'Only search scripts of this class type'
        },
        dryRun: {
          type: 'boolean',
          description: 'Preview changes without applying them (default: false)'
        },
        maxReplacements: {
          type: 'number',
          description: 'Safety limit on total replacements (default: 1000)'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['pattern', 'replacement']
    }
  },

  // === Documentation ===
  {
    name: 'get_roblox_docs',
    category: 'read',
    description: 'Fetch official Roblox engine API documentation as markdown from create.roblox.com. Call this BEFORE writing or editing code that uses an engine class, enum, datatype, or Luau library you are not fully certain about (e.g. ProximityPrompt, Enum.KeyCode, CFrame, TweenService) — the page includes the description, properties, methods, events, and code samples. Results are cached, so repeat lookups are cheap. Very large pages are truncated with a section index; pass section (e.g. "Properties", "Methods", "Events") to read one section in full.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Exact PascalCase name of the class, enum, datatype, or library (e.g. "ProximityPrompt", "KeyCode", "CFrame", "table")'
        },
        doc_type: {
          type: 'string',
          enum: ['classes', 'enums', 'datatypes', 'libraries', 'globals'],
          description: 'Documentation category (default: classes)'
        },
        section: {
          type: 'string',
          description: 'Optional "##"-level section to return instead of the whole page (e.g. "Description", "Properties", "Methods", "Events", "Code Samples")'
        }
      },
      required: ['name']
    }
  },
];

export const DEPRECATED_TOOL_DEFINITIONS: ToolDefinition[] = [
  // === Deprecated Playtest API ===
  {
    name: 'start_playtest',
    category: 'write',
    description: 'Deprecated. Use solo_playtest with action="start" instead. Starts a simple single-player Studio playtest in play or run mode.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['play', 'run'],
          description: 'Play mode'
        },
        numPlayers: {
          type: 'number',
          description: 'Deprecated and rejected. Use multiplayer_playtest action="start" for multi-client testing.'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['mode']
    }
  },
  {
    name: 'stop_playtest',
    category: 'write',
    description: 'Deprecated. Use solo_playtest with action="stop" instead. Stops a single-player Studio playtest and waits for runtime peers to disconnect.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      }
    }
  },
  {
    name: 'multiplayer_test_start',
    category: 'write',
    description: 'Deprecated. Use multiplayer_playtest with action="start" instead. Starts a StudioTestService multiplayer test only when force=true acknowledges that MCP cannot stop it and the test windows must be closed manually.',
    inputSchema: {
      type: 'object',
      properties: {
        numPlayers: {
          type: 'number',
          description: 'Number of client players to start (1-8).'
        },
        testArgs: {
          description: 'JSON-compatible table passed to StudioTestService:GetTestArgs() on server and clients.'
        },
        force: {
          type: 'boolean',
          description: 'Required. Pass true only if you understand StudioTestService:EndTest is broken in this flow and you will manually close the multiplayer test windows.'
        },
        timeout: {
          type: 'number',
          description: 'Max seconds to wait for server + clients to register (default 30).'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['numPlayers', 'force']
    }
  },
  {
    name: 'multiplayer_test_state',
    category: 'read',
    description: 'Deprecated. Use multiplayer_playtest with action="status" instead. Gets the active multiplayer StudioTestService state.',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to inspect. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      }
    }
  },
  {
    name: 'multiplayer_test_add_players',
    category: 'write',
    description: 'Deprecated. Use multiplayer_playtest with action="add_players" instead. Adds client players to a running StudioTestService multiplayer test.',
    inputSchema: {
      type: 'object',
      properties: {
        numPlayers: {
          type: 'number',
          description: 'Number of additional client players to add (1-8).'
        },
        timeout: {
          type: 'number',
          description: 'Max seconds to wait for new clients to register (default 30).'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      },
      required: ['numPlayers']
    }
  },
  {
    name: 'multiplayer_test_leave_client',
    category: 'write',
    description: 'Deprecated. Use multiplayer_playtest with action="leave_client" instead. Disconnects a specific client from a running StudioTestService multiplayer test.',
    inputSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: 'Client target to leave: "client-1" (default), "client-2", etc.'
        },
        timeout: {
          type: 'number',
          description: 'Max seconds to wait for the client peer to disconnect (default 30).'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      }
    }
  },
  {
    name: 'multiplayer_test_end',
    category: 'write',
    description: 'Deprecated. Multiplayer StudioTestService stop/end is disabled for now because StudioTestService:EndTest is broken in this flow. This tool returns a disabled error and does not call EndTest.',
    inputSchema: {
      type: 'object',
      properties: {
        value: {
          description: 'Ignored while multiplayer stop/end is disabled.'
        },
        timeout: {
          type: 'number',
          description: 'Ignored while multiplayer stop/end is disabled.'
        },
        instance_id: {
          type: 'string',
          description: 'Which connected Studio place to target. Required when multiple places are connected; omit when one. Use get_connected_instances to list available IDs.'
        }
      }
    }
  },
];

export const getReadOnlyTools = () => TOOL_DEFINITIONS.filter(t => t.category === 'read');
export const getAllTools = () => [...TOOL_DEFINITIONS];
export const getReadOnlyCallableTools = () => [...TOOL_DEFINITIONS, ...DEPRECATED_TOOL_DEFINITIONS].filter(t => t.category === 'read');
export const getAllCallableTools = () => [...TOOL_DEFINITIONS, ...DEPRECATED_TOOL_DEFINITIONS];
