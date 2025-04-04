#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "fs/promises";
import path from "path";
import os from 'os';
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { diffLines, createTwoFilesPatch } from 'diff';
import { minimatch } from 'minimatch';
import axios from 'axios';
import https from 'https';
import FormData from 'form-data';

// Command line argument parsing
const args = process.argv.slice(2);
if (args.length < 3) {
  console.error("Usage: synolink <synology-url> <username> <password> [api-version]");
  console.error("Current arguments:", args);
  process.exit(1);
}

const [synoUrl, synoUsername, synoPassword] = args;
const apiVersion = args[3] || '7';  // 기본값을 최신 DSM 버전으로 업데이트

// Synology DSM API configuration
const dsm = {
  baseUrl: synoUrl,
  apiVersion: apiVersion,
  account: synoUsername,
  passwd: synoPassword,
  sid: '',  // Session ID will be set after login
  httpsAgent: new https.Agent({
    rejectUnauthorized: false // Allow self-signed certificates
  })
};

// Synology API utilities
async function synoLogin() {
  try {
    console.error(`Attempting to login to ${dsm.baseUrl} with user ${dsm.account}...`);
    
    // 새로운 로그인 방식 (더 일반적인 DSM 7.x 양식)
    const params = new URLSearchParams();
    params.append('api', 'SYNO.API.Auth');
    params.append('version', '3');
    params.append('method', 'login');
    params.append('account', dsm.account);
    params.append('passwd', dsm.passwd);
    params.append('session', 'FileStation');
    params.append('format', 'sid');
    
    const loginUrl = `${dsm.baseUrl}/webapi/auth.cgi`;
    
    console.error(`Sending login request to ${loginUrl}`);
    
    const response = await axios.post(loginUrl, params, {
      httpsAgent: dsm.httpsAgent
    });
    
    console.error("Login response:", JSON.stringify(response.data));
    
    if (response.data && response.data.success) {
      dsm.sid = response.data.data.sid;
      console.error(`Login successful, got SID: ${dsm.sid.substring(0, 5)}...`);
      return true;
    } else {
      console.error("Login failed:", response.data);
      return false;
    }
  } catch (error: any) {
    console.error("Login error:", error.message);
    if (error.response) {
      console.error("Error response data:", error.response.data);
      console.error("Error response status:", error.response.status);
    }
    return false;
  }
}

async function synoLogout() {
  try {
    if (!dsm.sid) return true;
    
    const params = new URLSearchParams();
    params.append('api', 'SYNO.API.Auth');
    params.append('version', '6');
    params.append('method', 'logout');
    params.append('session', 'FileStation');
    params.append('_sid', dsm.sid);
    
    const logoutUrl = `${dsm.baseUrl}/webapi/entry.cgi`;
    
    console.error(`Attempting to logout from ${dsm.baseUrl}...`);
    
    const response = await axios.get(`${logoutUrl}?${params.toString()}`, {
      httpsAgent: dsm.httpsAgent
    });
    
    if (response.data && response.data.success) {
      console.error("Logout successful");
      dsm.sid = '';
      return true;
    } else {
      console.error("Logout failed:", response.data);
      return false;
    }
  } catch (error: any) {
    console.error("Logout error:", error.message);
    return false;
  }
}

// Ensure we're logged in before starting the server
async function ensureLogin() {
  if (!dsm.sid) {
    const loginSuccess = await synoLogin();
    if (!loginSuccess) {
      throw new Error("Failed to log in to Synology NAS");
    }
  }
  return true;
}

// Refresh session if needed
async function refreshSession() {
  try {
    // 먼저 간단히 현재 세션이 유효한지 확인
    console.error("Checking if session is still valid...");
    const infoUrl = `${dsm.baseUrl}/webapi/entry.cgi`;
    
    const params = new URLSearchParams();
    params.append('api', 'SYNO.API.Info');
    params.append('version', '1');
    params.append('method', 'query');
    params.append('query', 'SYNO.API.Auth');
    params.append('_sid', dsm.sid);
    
    const response = await axios.get(`${infoUrl}?${params.toString()}`, {
      httpsAgent: dsm.httpsAgent
    });
    
    // If the request fails due to session timeout, login again
    if (response.data && !response.data.success && response.data.error && response.data.error.code === 119) {
      console.error("Session expired, logging in again...");
      return await synoLogin();
    }
    
    console.error("Session is still valid");
    return true;
  } catch (error: any) {
    console.error("Session refresh error:", error.message);
    console.error("Attempting to login again...");
    return await synoLogin();
  }
}

// Path utilities
function formatSynoPath(filePath: string): string {
  // Ensure path starts with /
  if (!filePath.startsWith('/')) {
    filePath = '/' + filePath;
  }
  
  // Remove trailing slash except for root
  if (filePath !== '/' && filePath.endsWith('/')) {
    filePath = filePath.slice(0, -1);
  }
  
  return filePath;
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

// Schema definitions
const ListSharesArgsSchema = z.object({});

const ListDirectoryArgsSchema = z.object({
  path: z.string().describe('Path to list, must be absolute path with leading slash'),
});

const ReadFileArgsSchema = z.object({
  path: z.string().describe('Path to file, must be absolute path with leading slash'),
});

const WriteFileArgsSchema = z.object({
  path: z.string().describe('Path to file, must be absolute path with leading slash'),
  content: z.string().describe('Content to write to the file'),
});

const CreateDirectoryArgsSchema = z.object({
  path: z.string().describe('Path to create, must be absolute path with leading slash'),
});

const SearchFilesArgsSchema = z.object({
  path: z.string().describe('Path to search in, must be absolute path with leading slash'),
  pattern: z.string().describe('Search pattern'),
});

const GetFileInfoArgsSchema = z.object({
  path: z.string().describe('Path to file, must be absolute path with leading slash'),
});

const ToolInputSchema = ToolSchema.shape.inputSchema;
type ToolInput = z.infer<typeof ToolInputSchema>;

// Server setup
const server = new Server(
  {
    name: "synolink",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// API Wrappers
async function listShares() {
  try {
    await refreshSession();
    
    const url = `${dsm.baseUrl}/webapi/entry.cgi?api=SYNO.FileStation.List&version=2&method=list_share&_sid=${dsm.sid}`;
    
    const response = await axios.get(url, {
      httpsAgent: dsm.httpsAgent
    });
    
    if (response.data && response.data.success) {
      return response.data.data.shares;
    } else {
      throw new Error(`Failed to list shares: ${response.data.error.code}`);
    }
  } catch (error) {
    console.error("List shares error:", error);
    throw error;
  }
}

async function listDirectory(dirPath: string) {
  try {
    await refreshSession();
    
    const formattedPath = formatSynoPath(dirPath);
    const url = `${dsm.baseUrl}/webapi/entry.cgi?api=SYNO.FileStation.List&version=2&method=list&folder_path=${encodeURIComponent(formattedPath)}&_sid=${dsm.sid}`;
    
    const response = await axios.get(url, {
      httpsAgent: dsm.httpsAgent
    });
    
    if (response.data && response.data.success) {
      return response.data.data.files;
    } else {
      throw new Error(`Failed to list directory: ${response.data.error.code}`);
    }
  } catch (error) {
    console.error("List directory error:", error);
    throw error;
  }
}

async function readFile(filePath: string) {
  try {
    await refreshSession();
    
    const formattedPath = formatSynoPath(filePath);
    
    // Get download info
    const infoUrl = `${dsm.baseUrl}/webapi/entry.cgi?api=SYNO.FileStation.Download&version=2&method=download&path=${encodeURIComponent(formattedPath)}&mode=download&_sid=${dsm.sid}`;
    
    const response = await axios.get(infoUrl, {
      httpsAgent: dsm.httpsAgent,
      responseType: 'arraybuffer'
    });
    
    // Convert to text
    return new TextDecoder('utf-8').decode(response.data);
  } catch (error) {
    console.error("Read file error:", error);
    throw error;
  }
}

async function writeFile(filePath: string, content: string) {
  try {
    await refreshSession();
    
    const formattedPath = formatSynoPath(path.dirname(filePath));
    const fileName = path.basename(filePath);
    
    // Create FormData object
    const form = new FormData();
    form.append('path', formattedPath);
    form.append('create_parents', 'true');
    form.append('overwrite', 'true');
    
    // Add file content as a buffer with the filename
    const buffer = Buffer.from(content, 'utf-8');
    form.append('file', buffer, { filename: fileName });
    
    // Upload URL
    const uploadUrl = `${dsm.baseUrl}/webapi/entry.cgi?api=SYNO.FileStation.Upload&version=2&method=upload&_sid=${dsm.sid}`;
    
    const response = await axios.post(uploadUrl, form, {
      httpsAgent: dsm.httpsAgent,
      headers: form.getHeaders()
    });
    
    if (response.data && response.data.success) {
      return true;
    } else {
      throw new Error(`Failed to write file: ${response.data.error.code}`);
    }
  } catch (error) {
    console.error("Write file error:", error);
    throw error;
  }
}

async function createDirectory(dirPath: string) {
  try {
    await refreshSession();
    
    const formattedPath = formatSynoPath(dirPath);
    const parentPath = path.dirname(formattedPath);
    const folderName = path.basename(formattedPath);
    
    const url = `${dsm.baseUrl}/webapi/entry.cgi`;
    
    const params = new URLSearchParams();
    params.append('api', 'SYNO.FileStation.CreateFolder');
    params.append('version', '2');
    params.append('method', 'create');
    params.append('folder_path', parentPath);
    params.append('name', folderName);
    params.append('create_parents', 'true');
    params.append('_sid', dsm.sid);
    
    const response = await axios.post(url, params, {
      httpsAgent: dsm.httpsAgent
    });
    
    if (response.data && response.data.success) {
      return true;
    } else {
      throw new Error(`Failed to create directory: ${response.data.error.code}`);
    }
  } catch (error) {
    console.error("Create directory error:", error);
    throw error;
  }
}

async function searchFiles(searchPath: string, pattern: string) {
  try {
    await refreshSession();
    
    const formattedPath = formatSynoPath(searchPath);
    
    const url = `${dsm.baseUrl}/webapi/entry.cgi`;
    
    const params = new URLSearchParams();
    params.append('api', 'SYNO.FileStation.Search');
    params.append('version', '2');
    params.append('method', 'start');
    params.append('folder_path', formattedPath);
    params.append('pattern', pattern);
    params.append('_sid', dsm.sid);
    
    // Start search
    const startResponse = await axios.post(url, params, {
      httpsAgent: dsm.httpsAgent
    });
    
    if (!startResponse.data || !startResponse.data.success) {
      throw new Error(`Failed to start search: ${startResponse.data.error.code}`);
    }
    
    const taskId = startResponse.data.data.taskid;
    
    // Function to check search status
    const checkStatus = async () => {
      const statusParams = new URLSearchParams();
      statusParams.append('api', 'SYNO.FileStation.Search');
      statusParams.append('version', '2');
      statusParams.append('method', 'status');
      statusParams.append('taskid', taskId);
      statusParams.append('_sid', dsm.sid);
      
      const statusResponse = await axios.get(`${url}?${statusParams.toString()}`, {
        httpsAgent: dsm.httpsAgent
      });
      
      return statusResponse.data;
    };
    
    // Wait for search to complete
    let isFinished = false;
    while (!isFinished) {
      const status = await checkStatus();
      if (!status.success) {
        throw new Error(`Search status check failed: ${status.error.code}`);
      }
      
      isFinished = status.data.finished;
      if (!isFinished) {
        // Wait before checking again
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    // Get search results
    const resultParams = new URLSearchParams();
    resultParams.append('api', 'SYNO.FileStation.Search');
    resultParams.append('version', '2');
    resultParams.append('method', 'list');
    resultParams.append('taskid', taskId);
    resultParams.append('_sid', dsm.sid);
    
    const resultResponse = await axios.get(`${url}?${resultParams.toString()}`, {
      httpsAgent: dsm.httpsAgent
    });
    
    if (!resultResponse.data || !resultResponse.data.success) {
      throw new Error(`Failed to get search results: ${resultResponse.data.error.code}`);
    }
    
    // Clean up the task
    const cleanupParams = new URLSearchParams();
    cleanupParams.append('api', 'SYNO.FileStation.Search');
    cleanupParams.append('version', '2');
    cleanupParams.append('method', 'stop');
    cleanupParams.append('taskid', taskId);
    cleanupParams.append('_sid', dsm.sid);
    
    await axios.post(url, cleanupParams, {
      httpsAgent: dsm.httpsAgent
    });
    
    return resultResponse.data.data.files;
  } catch (error) {
    console.error("Search files error:", error);
    throw error;
  }
}

async function getFileInfo(filePath: string) {
  try {
    await refreshSession();
    
    const formattedPath = formatSynoPath(filePath);
    const url = `${dsm.baseUrl}/webapi/entry.cgi?api=SYNO.FileStation.List&version=2&method=getinfo&path=${encodeURIComponent(formattedPath)}&additional=time,size,owner,perm&_sid=${dsm.sid}`;
    
    const response = await axios.get(url, {
      httpsAgent: dsm.httpsAgent
    });
    
    if (response.data && response.data.success) {
      return response.data.data.files[0];
    } else {
      throw new Error(`Failed to get file info: ${response.data.error.code}`);
    }
  } catch (error) {
    console.error("Get file info error:", error);
    throw error;
  }
}

// Tool handlers
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "list_shares",
        description:
          "List all available shares on the Synology NAS. " +
          "Returns information about each share including name, path, and description.",
        inputSchema: zodToJsonSchema(ListSharesArgsSchema) as ToolInput,
      },
      {
        name: "list_directory",
        description:
          "List all files and folders in the specified directory on the Synology NAS. " +
          "Returns detailed information about each item including name, type, size, " +
          "and modification time. The path must be absolute with a leading slash.",
        inputSchema: zodToJsonSchema(ListDirectoryArgsSchema) as ToolInput,
      },
      {
        name: "read_file",
        description:
          "Read the contents of a file from the Synology NAS. " +
          "The path must be absolute with a leading slash.",
        inputSchema: zodToJsonSchema(ReadFileArgsSchema) as ToolInput,
      },
      {
        name: "write_file",
        description:
          "Write content to a file on the Synology NAS. Creates the file if it " +
          "doesn't exist, otherwise overwrites it. The path must be absolute with a leading slash.",
        inputSchema: zodToJsonSchema(WriteFileArgsSchema) as ToolInput,
      },
      {
        name: "create_directory",
        description:
          "Create a new directory on the Synology NAS. Will create parent directories " +
          "if they don't exist. The path must be absolute with a leading slash.",
        inputSchema: zodToJsonSchema(CreateDirectoryArgsSchema) as ToolInput,
      },
      {
        name: "search_files",
        description:
          "Search for files and directories on the Synology NAS. " +
          "The search is performed recursively starting from the specified path. " +
          "Returns all files and directories matching the pattern. " +
          "The path must be absolute with a leading slash.",
        inputSchema: zodToJsonSchema(SearchFilesArgsSchema) as ToolInput,
      },
      {
        name: "get_file_info",
        description:
          "Get detailed information about a file or directory on the Synology NAS. " +
          "Returns information such as size, permissions, creation time, " +
          "and modification time. The path must be absolute with a leading slash.",
        inputSchema: zodToJsonSchema(GetFileInfoArgsSchema) as ToolInput,
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;

    switch (name) {
      case "list_shares": {
        const shares = await listShares();
        const formatted = shares.map((share: any) => ({
          name: share.name,
          path: share.path,
          description: share.desc
        }));
        return {
          content: [{ type: "text", text: JSON.stringify(formatted, null, 2) }],
        };
      }

      case "list_directory": {
        const parsed = ListDirectoryArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for list_directory: ${parsed.error}`);
        }
        const files = await listDirectory(parsed.data.path);
        
        const formatted = files.map((file: any) => ({
          name: file.name,
          type: file.isdir ? "directory" : "file",
          size: file.size,
          modified: file.time.mtime
        }));
        
        return {
          content: [{ type: "text", text: JSON.stringify(formatted, null, 2) }],
        };
      }

      case "read_file": {
        const parsed = ReadFileArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for read_file: ${parsed.error}`);
        }
        const content = await readFile(parsed.data.path);
        return {
          content: [{ type: "text", text: content }],
        };
      }

      case "write_file": {
        const parsed = WriteFileArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for write_file: ${parsed.error}`);
        }
        await writeFile(parsed.data.path, parsed.data.content);
        return {
          content: [{ type: "text", text: `Successfully wrote to ${parsed.data.path}` }],
        };
      }

      case "create_directory": {
        const parsed = CreateDirectoryArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for create_directory: ${parsed.error}`);
        }
        await createDirectory(parsed.data.path);
        return {
          content: [{ type: "text", text: `Successfully created directory ${parsed.data.path}` }],
        };
      }

      case "search_files": {
        const parsed = SearchFilesArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for search_files: ${parsed.error}`);
        }
        const results = await searchFiles(parsed.data.path, parsed.data.pattern);
        
        const formatted = results.map((file: any) => ({
          name: file.name,
          path: file.path,
          type: file.isdir ? "directory" : "file",
          size: file.size
        }));
        
        return {
          content: [{ type: "text", text: JSON.stringify(formatted, null, 2) }],
        };
      }

      case "get_file_info": {
        const parsed = GetFileInfoArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for get_file_info: ${parsed.error}`);
        }
        const info = await getFileInfo(parsed.data.path);
        
        const formatted = {
          name: info.name,
          path: info.path,
          type: info.isdir ? "directory" : "file",
          size: info.size,
          owner: info.additional?.owner?.user || "unknown",
          group: info.additional?.owner?.group || "unknown",
          permissions: info.additional?.perm?.posix || "unknown",
          created: info.additional?.time?.crtime || "unknown",
          modified: info.additional?.time?.mtime || "unknown",
          accessed: info.additional?.time?.atime || "unknown"
        };
        
        return {
          content: [{ type: "text", text: JSON.stringify(formatted, null, 2) }],
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

// Process termination handling
process.on('SIGINT', async () => {
  console.error("Received SIGINT signal, cleaning up...");
  await synoLogout();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.error("Received SIGTERM signal, cleaning up...");
  await synoLogout();
  process.exit(0);
});

// Start server
async function runServer() {
  try {
    console.error("SynoLink MCP Server starting...");
    console.error(`Connecting to Synology NAS at ${dsm.baseUrl}`);
    console.error(`Using username: ${dsm.account}`);
    console.error(`API version: ${dsm.apiVersion}`);
    
    // Login to Synology DSM
    const loginSuccess = await synoLogin();
    if (!loginSuccess) {
      console.error("Failed to log in to Synology NAS. Check credentials and network connectivity.");
      process.exit(1);
    }
    
    console.error("Successfully logged in to Synology NAS");
    
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("SynoLink MCP Server running on stdio");
    console.error(`Connected to Synology NAS at ${dsm.baseUrl}`);
  } catch (error: any) {
    console.error("Fatal error running server:", error);
    if (error.response) {
      console.error("Error response data:", error.response.data);
      console.error("Error response status:", error.response.status);
      console.error("Error response headers:", error.response.headers);
    }
    await synoLogout();
    process.exit(1);
  }
}

runServer().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});