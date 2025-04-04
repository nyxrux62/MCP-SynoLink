#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolSchema,
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import FormData from "form-data";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// Command line argument parsing
const args = process.argv.slice(2);
if (args.length < 3) {
  console.error("Usage: mcp-synolink <synology-url> <username> <password>");
  process.exit(1);
}

const SYNOLOGY_URL = args[0];
const USERNAME = args[1];
const PASSWORD = args[2];

// Session ID storage
let sid: string | null = null;

// Schema definitions
const LoginArgsSchema = z.object({});

const LogoutArgsSchema = z.object({});

const ListFoldersArgsSchema = z.object({
  path: z.string().describe("Path to list files from, e.g., '/photos'"),
});

const GetFileArgsSchema = z.object({
  path: z.string().describe("Full path to the file on Synology NAS"),
});

const UploadFileArgsSchema = z.object({
  path: z.string().describe("Destination path on Synology NAS including filename"),
  content: z.string().describe("Content of the file to upload"),
});

const CreateFolderArgsSchema = z.object({
  path: z.string().describe("Full path to create folder at"),
  name: z.string().describe("Name of the new folder"),
});

const DeleteItemArgsSchema = z.object({
  path: z.string().describe("Full path to the file or folder to delete"),
});

const MoveItemArgsSchema = z.object({
  source: z.string().describe("Full path to the source file or folder"),
  destination: z.string().describe("Full path to the destination location"),
});

const SearchArgsSchema = z.object({
  keyword: z.string().describe("Search keyword"),
  path: z.string().describe("Path to search in").default("/"),
});

const GetShareLinksArgsSchema = z.object({
  path: z.string().describe("Path to get share links for"),
});

const GetServerInfoArgsSchema = z.object({});

const GetQuotaInfoArgsSchema = z.object({
  volume: z.string().describe("Volume name").optional(),
});

const ToolInputSchema = ToolSchema.shape.inputSchema;
type ToolInput = z.infer<typeof ToolInputSchema>;

interface FileInfo {
  size: number;
  created: Date;
  modified: Date;
  accessed: Date;
  isDirectory: boolean;
  isFile: boolean;
  permissions: string;
}

// Helper functions
async function login(): Promise<string> {
  try {
    if (sid) return sid;

    const response = await axios.get(`${SYNOLOGY_URL}/webapi/auth.cgi`, {
      params: {
        api: 'SYNO.API.Auth',
        version: '6',
        method: 'login',
        account: USERNAME,
        passwd: PASSWORD,
        session: 'FileStation',
        format: 'sid'
      }
    });

    if (response.data.success) {
      sid = response.data.data.sid;
      // Ensure we're returning a string (not null)
      if (sid === null) {
        throw new Error("Failed to get session ID");
      }
      return sid;
    } else {
      throw new Error(response.data.error?.code ? `Error ${response.data.error.code}` : "Login failed");
    }
  } catch (error) {
    console.error('Login failed:', error);
    throw new Error('Failed to authenticate with Synology NAS');
  }
}

async function logout(): Promise<void> {
  if (!sid) return;

  try {
    await axios.get(`${SYNOLOGY_URL}/webapi/auth.cgi`, {
      params: {
        api: 'SYNO.API.Auth',
        version: '6',
        method: 'logout',
        session: 'FileStation',
        _sid: sid
      }
    });
    sid = null;
  } catch (error) {
    console.error('Logout failed:', error);
  }
}

// Server setup
const server = new Server(
  {
    name: "synolink-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// Tool implementations
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "login",
        description: "Login to Synology NAS",
        inputSchema: zodToJsonSchema(LoginArgsSchema) as ToolInput,
      },
      {
        name: "logout",
        description: "Logout from Synology NAS",
        inputSchema: zodToJsonSchema(LogoutArgsSchema) as ToolInput,
      },
      {
        name: "list_folders",
        description: "List files and folders in the specified path",
        inputSchema: zodToJsonSchema(ListFoldersArgsSchema) as ToolInput,
      },
      {
        name: "get_file",
        description: "Get the content of a file from Synology NAS",
        inputSchema: zodToJsonSchema(GetFileArgsSchema) as ToolInput,
      },
      {
        name: "upload_file",
        description: "Upload a file to Synology NAS",
        inputSchema: zodToJsonSchema(UploadFileArgsSchema) as ToolInput,
      },
      {
        name: "create_folder",
        description: "Create a new folder on Synology NAS",
        inputSchema: zodToJsonSchema(CreateFolderArgsSchema) as ToolInput,
      },
      {
        name: "delete_item",
        description: "Delete a file or folder from Synology NAS",
        inputSchema: zodToJsonSchema(DeleteItemArgsSchema) as ToolInput,
      },
      {
        name: "move_item",
        description: "Move or rename a file or folder on Synology NAS",
        inputSchema: zodToJsonSchema(MoveItemArgsSchema) as ToolInput,
      },
      {
        name: "search",
        description: "Search for files and folders by keyword",
        inputSchema: zodToJsonSchema(SearchArgsSchema) as ToolInput,
      },
      {
        name: "get_share_links",
        description: "Get sharing links for a file or folder",
        inputSchema: zodToJsonSchema(GetShareLinksArgsSchema) as ToolInput,
      },
      {
        name: "get_server_info",
        description: "Get Synology server information",
        inputSchema: zodToJsonSchema(GetServerInfoArgsSchema) as ToolInput,
      },
      {
        name: "get_quota_info",
        description: "Get quota information for the specified volume",
        inputSchema: zodToJsonSchema(GetQuotaInfoArgsSchema) as ToolInput,
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;

    switch (name) {
      case "login": {
        const sessionId = await login();
        return {
          content: [{ type: "text", text: `Successfully logged in with session ID: ${sessionId}` }],
        };
      }

      case "logout": {
        await logout();
        return {
          content: [{ type: "text", text: "Successfully logged out" }],
        };
      }

      case "list_folders": {
        const parsed = ListFoldersArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments: ${parsed.error}`);
        }

        const sessionId = await login();
        const response = await axios.get(`${SYNOLOGY_URL}/webapi/entry.cgi`, {
          params: {
            api: 'SYNO.FileStation.List',
            version: '2',
            method: 'list',
            folder_path: parsed.data.path,
            _sid: sessionId
          }
        });

        if (!response.data.success) {
          throw new Error(`Error ${response.data.error?.code}: ${response.data.error?.errors?.[0]?.message || 'Unknown error'}`);
        }

        const files = response.data.data.files;
        let result = `Items in ${parsed.data.path}:\n`;

        files.forEach((file: any) => {
          const type = file.isdir ? "[DIR]" : "[FILE]";
          result += `${type} ${file.name}\n`;
        });

        return {
          content: [{ type: "text", text: result }],
        };
      }

      case "get_file": {
        const parsed = GetFileArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments: ${parsed.error}`);
        }

        const sessionId = await login();
        
        // First get file info to check if it exists
        const infoResponse = await axios.get(`${SYNOLOGY_URL}/webapi/entry.cgi`, {
          params: {
            api: 'SYNO.FileStation.List',
            version: '2',
            method: 'getinfo',
            path: parsed.data.path,
            _sid: sessionId
          }
        });

        if (!infoResponse.data.success) {
          throw new Error(`Error: File not found or cannot be accessed`);
        }

        // Then download the file
        const fileResponse = await axios.get(`${SYNOLOGY_URL}/webapi/entry.cgi`, {
          params: {
            api: 'SYNO.FileStation.Download',
            version: '2',
            method: 'download',
            path: parsed.data.path,
            mode: 'open',
            _sid: sessionId
          },
          responseType: 'text'
        });

        return {
          content: [{ type: "text", text: fileResponse.data }],
        };
      }

      case "upload_file": {
        const parsed = UploadFileArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments: ${parsed.error}`);
        }

        const sessionId = await login();
        const form = new FormData();
        const folderPath = parsed.data.path.substring(0, parsed.data.path.lastIndexOf('/'));
        const fileName = parsed.data.path.substring(parsed.data.path.lastIndexOf('/') + 1);

        form.append('filedata', Buffer.from(parsed.data.content), {
          filename: fileName,
          contentType: 'application/octet-stream',
        });
        
        form.append('api', 'SYNO.FileStation.Upload');
        form.append('version', '2');
        form.append('method', 'upload');
        form.append('path', folderPath);
        form.append('create_parents', 'true');
        form.append('overwrite', 'true');
        form.append('_sid', sessionId);

        const response = await axios.post(`${SYNOLOGY_URL}/webapi/entry.cgi`, form, {
          headers: {
            ...form.getHeaders(),
          },
        });

        if (!response.data.success) {
          throw new Error(`Upload failed: ${response.data.error?.code}`);
        }

        return {
          content: [{ type: "text", text: `Successfully uploaded file to ${parsed.data.path}` }],
        };
      }

      case "create_folder": {
        const parsed = CreateFolderArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments: ${parsed.error}`);
        }

        const sessionId = await login();
        const response = await axios.get(`${SYNOLOGY_URL}/webapi/entry.cgi`, {
          params: {
            api: 'SYNO.FileStation.CreateFolder',
            version: '2',
            method: 'create',
            folder_path: parsed.data.path,
            name: parsed.data.name,
            create_parents: 'true',
            _sid: sessionId
          }
        });

        if (!response.data.success) {
          throw new Error(`Failed to create folder: ${response.data.error?.code}`);
        }

        return {
          content: [{ type: "text", text: `Successfully created folder ${parsed.data.name} at ${parsed.data.path}` }],
        };
      }

      case "delete_item": {
        const parsed = DeleteItemArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments: ${parsed.error}`);
        }

        const sessionId = await login();
        const response = await axios.get(`${SYNOLOGY_URL}/webapi/entry.cgi`, {
          params: {
            api: 'SYNO.FileStation.Delete',
            version: '2',
            method: 'delete',
            path: parsed.data.path,
            recursive: 'true',
            _sid: sessionId
          }
        });

        if (!response.data.success) {
          throw new Error(`Failed to delete item: ${response.data.error?.code}`);
        }

        return {
          content: [{ type: "text", text: `Successfully deleted ${parsed.data.path}` }],
        };
      }

      case "move_item": {
        const parsed = MoveItemArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments: ${parsed.error}`);
        }

        const sessionId = await login();
        const destFolder = parsed.data.destination.substring(0, parsed.data.destination.lastIndexOf('/'));
        const newName = parsed.data.destination.substring(parsed.data.destination.lastIndexOf('/') + 1);

        const response = await axios.get(`${SYNOLOGY_URL}/webapi/entry.cgi`, {
          params: {
            api: 'SYNO.FileStation.Rename',
            version: '2',
            method: 'rename',
            path: parsed.data.source,
            dest_folder_path: destFolder,
            name: newName,
            _sid: sessionId
          }
        });

        if (!response.data.success) {
          throw new Error(`Failed to move/rename item: ${response.data.error?.code}`);
        }

        return {
          content: [{ type: "text", text: `Successfully moved ${parsed.data.source} to ${parsed.data.destination}` }],
        };
      }

      case "search": {
        const parsed = SearchArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments: ${parsed.error}`);
        }

        const sessionId = await login();
        const response = await axios.get(`${SYNOLOGY_URL}/webapi/entry.cgi`, {
          params: {
            api: 'SYNO.FileStation.Search',
            version: '2',
            method: 'start',
            folder_path: parsed.data.path,
            pattern: parsed.data.keyword,
            _sid: sessionId
          }
        });

        if (!response.data.success) {
          throw new Error(`Search failed: ${response.data.error?.code}`);
        }

        const taskId = response.data.data.taskid;
        
        // Wait for search to complete
        let isFinished = false;
        let result = "";
        
        while (!isFinished) {
          await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
          
          const statusResponse = await axios.get(`${SYNOLOGY_URL}/webapi/entry.cgi`, {
            params: {
              api: 'SYNO.FileStation.Search',
              version: '2',
              method: 'status',
              taskid: taskId,
              _sid: sessionId
            }
          });
          
          if (statusResponse.data.data.finished) {
            isFinished = true;
            
            // Get search results
            const resultResponse = await axios.get(`${SYNOLOGY_URL}/webapi/entry.cgi`, {
              params: {
                api: 'SYNO.FileStation.Search',
                version: '2',
                method: 'list',
                taskid: taskId,
                _sid: sessionId
              }
            });
            
            if (resultResponse.data.success) {
              const files = resultResponse.data.data.files;
              result = `Search results for "${parsed.data.keyword}" in ${parsed.data.path}:\n`;
              
              files.forEach((file: any) => {
                const type = file.isdir ? "[DIR]" : "[FILE]";
                result += `${type} ${file.path}\n`;
              });
              
              if (files.length === 0) {
                result += "No results found.\n";
              }
            }
            
            // Clean up the task
            await axios.get(`${SYNOLOGY_URL}/webapi/entry.cgi`, {
              params: {
                api: 'SYNO.FileStation.Search',
                version: '2',
                method: 'stop',
                taskid: taskId,
                _sid: sessionId
              }
            });
          }
        }

        return {
          content: [{ type: "text", text: result }],
        };
      }

      case "get_share_links": {
        const parsed = GetShareLinksArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments: ${parsed.error}`);
        }

        const sessionId = await login();
        
        // First create a share link
        const createResponse = await axios.get(`${SYNOLOGY_URL}/webapi/entry.cgi`, {
          params: {
            api: 'SYNO.FileStation.Sharing',
            version: '3',
            method: 'create',
            path: parsed.data.path,
            _sid: sessionId
          }
        });

        if (!createResponse.data.success) {
          throw new Error(`Failed to create share link: ${createResponse.data.error?.code}`);
        }

        // Then list all share links
        const listResponse = await axios.get(`${SYNOLOGY_URL}/webapi/entry.cgi`, {
          params: {
            api: 'SYNO.FileStation.Sharing',
            version: '3',
            method: 'list',
            _sid: sessionId
          }
        });

        if (!listResponse.data.success) {
          throw new Error(`Failed to list share links: ${listResponse.data.error?.code}`);
        }

        const links = listResponse.data.data.links;
        let result = `Share links for ${parsed.data.path}:\n`;
        
        links.forEach((link: any) => {
          if (link.path === parsed.data.path) {
            result += `URL: ${link.url}\n`;
            if (link.expire_time) {
              const expireDate = new Date(link.expire_time * 1000);
              result += `Expires: ${expireDate.toLocaleString()}\n`;
            } else {
              result += "No expiration date\n";
            }
          }
        });

        return {
          content: [{ type: "text", text: result }],
        };
      }

      case "get_server_info": {
        const sessionId = await login();
        const response = await axios.get(`${SYNOLOGY_URL}/webapi/entry.cgi`, {
          params: {
            api: 'SYNO.FileStation.Info',
            version: '2',
            method: 'get',
            _sid: sessionId
          }
        });

        if (!response.data.success) {
          throw new Error(`Failed to get server info: ${response.data.error?.code}`);
        }

        const info = response.data.data;
        let result = "Synology Server Information:\n";
        result += `Hostname: ${info.hostname}\n`;
        result += `DSM Version: ${info.version}\n`;
        result += `Time: ${new Date(info.time * 1000).toLocaleString()}\n`;
        result += `Filesystem support:\n`;
        
        for (const [fs, supported] of Object.entries(info.support_virtual_protocol)) {
          result += `  - ${fs}: ${supported ? "Yes" : "No"}\n`;
        }

        return {
          content: [{ type: "text", text: result }],
        };
      }

      case "get_quota_info": {
        const parsed = GetQuotaInfoArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments: ${parsed.error}`);
        }

        const sessionId = await login();
        const response = await axios.get(`${SYNOLOGY_URL}/webapi/entry.cgi`, {
          params: {
            api: 'SYNO.FileStation.Volume',
            version: '1',
            method: 'list',
            _sid: sessionId
          }
        });

        if (!response.data.success) {
          throw new Error(`Failed to get quota info: ${response.data.error?.code}`);
        }

        const volumes = response.data.data.volumes;
        let result = "Storage Volume Information:\n";
        
        volumes.forEach((volume: any) => {
          if (!parsed.data.volume || volume.name === parsed.data.volume) {
            result += `Volume: ${volume.name}\n`;
            result += `  - Status: ${volume.status}\n`;
            result += `  - File System: ${volume.filesystem}\n`;
            
            const totalSize = volume.total_size;
            const freeSize = volume.free_size;
            const usedSize = totalSize - freeSize;
            const usedPercent = Math.round((usedSize / totalSize) * 100);
            
            result += `  - Total Size: ${formatBytes(totalSize)}\n`;
            result += `  - Used: ${formatBytes(usedSize)} (${usedPercent}%)\n`;
            result += `  - Free: ${formatBytes(freeSize)}\n`;
          }
        });

        return {
          content: [{ type: "text", text: result }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${errorMessage}` }],
      isError: true,
    };
  }
});

// Helper function to format bytes to human-readable format
function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// Start server
async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Synology MCP Server running on stdio");
  console.error(`Connected to: ${SYNOLOGY_URL}`);
}

runServer().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});

// Handle process exit to ensure logout
process.on('exit', async () => {
  await logout();
});

process.on('SIGINT', async () => {
  await logout();
  process.exit(0);
});
