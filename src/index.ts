import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";

dotenv.config({
  path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env"),
});

const BASIC_AUTH_TOKEN = Buffer.from(
  `${process.env.KAGGLE_USERNAME}:${process.env.KAGGLE_KEY}`
).toString("base64");
const DEFAULT_ORIGIN = "https://www.kaggle.com";
const API_V1_KERNELS = "api/v1/kernels";
const API_V1_KERNELS_PULL = `${API_V1_KERNELS}/pull`;
const API_V1_KERNELS_STATUS = `${API_V1_KERNELS}/status`;
const ALLOWED_DOMAINS = [
  "kaggle.com",
  "www.kaggle.com",
  "localhost",
];
const CROISSANT_DOWNLOAD_SUFFIX = "croissant/download";

// Create server instance
const server = new McpServer({
  name: "kaggle-croissant",
  version: "1.0.0",
  capabilities: {
    resources: {},
    tools: {},
  },
});

const BASIC_SEARCH_PAYLOAD = {
  page: 1,
  search: "",
};

// Helper function for making requests
async function makeKaggleGetRequest(url: string): Promise<any | null> {
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Basic ${BASIC_AUTH_TOKEN}` },
    });
    if (!response.ok) {
      throw new Error(`GET error! status: ${response.status} ${response.text()}`);
    }
    return await response.text();
  } catch (error) {
    console.error(`Error making ${url} request:`, error);
    return null;
  }
}

async function makeKaggleDatasetsSearchRequest(
  searchQuery: string
): Promise<any[] | null> {
  const body = JSON.stringify({ ...BASIC_SEARCH_PAYLOAD, search: searchQuery });
  try {
    const response = await fetch(
      `https://www.kaggle.com/api/v1/datasets/list?search=${encodeURIComponent(
        searchQuery
      )}`,
      {
        headers: { Authorization: `Basic ${BASIC_AUTH_TOKEN}` },
      }
    );
    if (!response.ok) {
      throw new Error(
        `Search error! status: ${response.status} ${await response.text()}`
      );
    }
    return await response.json();
  } catch (error) {
    console.error("Error making search request:", error, searchQuery);
    return null;
  }
}

async function makeKaggleKernelPushRequest(
  notebookContent: string,
  notebookTitle: string,
  datasetHandle: string
): Promise<any[] | null> {
  try {
    const body = JSON.stringify({
      text: JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        cells: [
          {
            source: notebookContent,
            cell_type: "code",
            metadata: {},
          },
        ],
        metadata: {
          kernelspec: {
            display_name: "Python 3 (ipykernel)", // Adjust if needed
            language: "python",
            name: "python3",
          },
        },
      }),
      datasetDataSources: [datasetHandle],
      newTitle: notebookTitle,
      slug: `${process.env.KAGGLE_USERNAME}/${notebookTitle
        .toLowerCase()
        .replaceAll(" ", "-")}`,
      language: "python",
      kernelType: "notebook",
    });
    const response = await fetch("https://www.kaggle.com/api/v1/kernels/push", {
      method: "POST",
      headers: { Authorization: `Basic ${BASIC_AUTH_TOKEN}` },
      body,
    });
    if (!response.ok) {
      throw new Error(
        `Notebook push error! status: ${
          response.status
        } ${await response.text()}`
      );
    }
    return await response.json();
  } catch (error) {
    console.error("Error making notebook request:", error);
    return null;
  }
}

// Register tools
server.tool(
  "get-dataset-metadata",
  `Get the metadata for a Kaggle dataset in Croissant (JSON-LD) format. This metadata contains information about
    the dataset overall, as well as schema-level information about any tabular files contained within the dataset.`,
  {
    kaggleUrl: z
      .string()
      .url()
      .refine(
        (value) => {
          try {
            const url = new URL(value);
            return ALLOWED_DOMAINS.includes(url.hostname);
          } catch (error) {
            return false;
          }
        },
        {
          message: `URL must be from one of the following domains: ${ALLOWED_DOMAINS.join(
            ", "
          )}`,
        }
      )
      .refine(
        (value) => {
          try {
            const url = new URL(value);
            // Make sure it's a dataset URL and that it has teh
            return (
              url.pathname.startsWith("/datasets") &&
              url.pathname.split("/").length >= 4
            );
          } catch (error) {
            return false;
          }
        },
        {
          message:
            "URL path must start with /datasets and have <owner_slug>/<dataset_slug>",
        }
      )
      .optional()
      .describe("The full Kaggle Dataset URL to get metadata for."),
    datasetHandle: z
      .string()
      .refine(
        (value) => {
          return value.split("/").length === 2;
        },
        {
          message: "Kaggle slugs must contain an owner slug and dataset slug",
        }
      )
      .optional()
      .describe(
        "The dataset handle (in the form of <owner_slug>/<dataset_slug>) to get metadata for."
      ),
  },
  async ({ kaggleUrl, datasetHandle }) => {
    let croissantUrl;
    if (datasetHandle) {
      croissantUrl = `${DEFAULT_ORIGIN}/${datasetHandle}/${CROISSANT_DOWNLOAD_SUFFIX}`;
    } else if (kaggleUrl) {
      const structuredUrl = new URL(kaggleUrl);
      const [_emptyString, _datasets, ownerSlug, datasetSlug] =
        structuredUrl.pathname.split("/");
      croissantUrl = `${structuredUrl.origin}/${ownerSlug}/${datasetSlug}/${CROISSANT_DOWNLOAD_SUFFIX}`;
    } else {
      throw new RangeError("No params provided!");
    }

    const croissantJson = await makeKaggleGetRequest(croissantUrl);

    if (!croissantJson) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to retrieve Croissant for ${
              kaggleUrl || datasetHandle
            }`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: croissantJson,
        },
      ],
    };
  }
);

server.tool(
  "search-kaggle-datasets",
  "Using a provided search query, search for datasets on Kaggle",
  {
    searchQuery: z
      .string()
      .describe("The search term to use when querying datasets on Kaggle."),
  },
  async ({ searchQuery }) => {
    const searchResults = await makeKaggleDatasetsSearchRequest(searchQuery);

    if (!searchResults?.length) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to find results for ${searchQuery} ${JSON.stringify(
              searchResults
            )}`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(searchResults),
        },
      ],
    };
  }
);

server.tool(
  "make-kaggle-notebook-with-dataset",
  "Make a notebook on Kaggle using the provided notebook content and dataset handles.",
  {
    notebookContent: z
      .string()
      .describe("The notebook content to put in the Kaggle notebook."),
    notebookTitle: z
      .string()
      .describe("The title of the notebook being created."),
    datasetHandle: z
      .string()
      .refine(
        (value) => {
          return value.split("/").length === 2;
        },
        {
          message: "Kaggle slugs must contain an owner slug and dataset slug",
        }
      )
      .describe(
        "The dataset (in the form of <owner_slug>/<dataset_slug>) to attach to the notebook."
      ),
  },
  async ({ notebookContent, notebookTitle, datasetHandle }) => {
    const kernelResult = await makeKaggleKernelPushRequest(
      notebookContent,
      notebookTitle,
      datasetHandle
    );

    if (!kernelResult) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to create notebook with content ${notebookContent} and dataset ${datasetHandle}} ${JSON.stringify(
              kernelResult
            )}`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(kernelResult),
        },
      ],
    };
  }
);

server.tool(
  "get-kaggle-notebook-status",
  "Get the status of a Kaggle Notebook.",
  {
    kaggleUrl: z
      .string()
      .url()
      .refine(
        (value) => {
          try {
            const url = new URL(value);
            return ALLOWED_DOMAINS.includes(url.hostname);
          } catch (error) {
            return false;
          }
        },
        {
          message: `URL must be from one of the following domains: ${ALLOWED_DOMAINS.join(
            ", "
          )}`,
        }
      )
      .refine(
        (value) => {
          try {
            const url = new URL(value);
            // Make sure it's a dataset URL and that it has teh
            return (
              url.pathname.startsWith("/code") &&
              url.pathname.split("/").length >= 4
            );
          } catch (error) {
            return false;
          }
        },
        {
          message:
            "URL path must start with /code and have <owner_slug>/<notebookt_slug>",
        }
      )
      .optional()
      .describe("The full Kaggle Notebook URL to fetch the status for."),
    notebookHandle: z
      .string()
      .refine(
        (value) => {
          return value.split("/").length === 2;
        },
        {
          message: "Kaggle slugs must contain an owner slug and notebook slug",
        }
      )
      .optional()
      .describe(
        "The notebook handle (in the form of <owner_slug>/<notebook_slug>) to get the status for."
      ),
  },
  async ({ kaggleUrl, notebookHandle }) => {
    let pullNotebookApiUrl;
    if (notebookHandle) {
      const [ownerSlug, notebookSlug] = notebookHandle.split("/");
      pullNotebookApiUrl = `${DEFAULT_ORIGIN}/${API_V1_KERNELS_STATUS}?userName=${ownerSlug}&kernelSlug=${notebookSlug}`;
    } else if (kaggleUrl) {
      const structuredUrl = new URL(kaggleUrl);
      const [_emptyString, _code, ownerSlug, notebookSlug] =
        structuredUrl.pathname.split("/");
      pullNotebookApiUrl = `${structuredUrl.origin}/${API_V1_KERNELS_STATUS}?userName=${ownerSlug}&kernelSlug=${notebookSlug}`;
    } else {
      throw new RangeError("No params provided!");
    }

    const response = await makeKaggleGetRequest(pullNotebookApiUrl);

    if (!response) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to retrieve notebook status for ${
              kaggleUrl || notebookHandle
            }`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: response,
        },
      ],
    };
  }
);

server.tool(
  "get-kaggle-notebook-content",
  "Get the contents of a Kaggle Notebook.",
  {
    kaggleUrl: z
      .string()
      .url()
      .refine(
        (value) => {
          try {
            const url = new URL(value);
            return ALLOWED_DOMAINS.includes(url.hostname);
          } catch (error) {
            return false;
          }
        },
        {
          message: `URL must be from one of the following domains: ${ALLOWED_DOMAINS.join(
            ", "
          )}`,
        }
      )
      .refine(
        (value) => {
          try {
            const url = new URL(value);
            // Make sure it's a dataset URL and that it has teh
            return (
              url.pathname.startsWith("/code") &&
              url.pathname.split("/").length >= 4
            );
          } catch (error) {
            return false;
          }
        },
        {
          message:
            "URL path must start with /code and have <owner_slug>/<notebookt_slug>",
        }
      )
      .optional()
      .describe("The full Kaggle Notebook URL to fetch content for."),
    notebookHandle: z
      .string()
      .refine(
        (value) => {
          return value.split("/").length === 2;
        },
        {
          message: "Kaggle slugs must contain an owner slug and notebook slug",
        }
      )
      .optional()
      .describe(
        "The notebook handle (in the form of <owner_slug>/<notebook_slug>) to get content for."
      ),
  },
  async ({ kaggleUrl, notebookHandle }) => {
    let pullNotebookApiUrl;
    if (notebookHandle) {
      pullNotebookApiUrl = `${DEFAULT_ORIGIN}/${API_V1_KERNELS_PULL}/${notebookHandle}`;
    } else if (kaggleUrl) {
      const structuredUrl = new URL(kaggleUrl);
      const [_emptyString, _code, ownerSlug, notebookSlug] =
        structuredUrl.pathname.split("/");
      pullNotebookApiUrl = `${structuredUrl.origin}${API_V1_KERNELS_PULL}//${ownerSlug}/${notebookSlug}`;
    } else {
      throw new RangeError("No params provided!");
    }

    const response = await makeKaggleGetRequest(pullNotebookApiUrl);

    if (!response) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to retrieve notebook for ${
              kaggleUrl || notebookHandle
            }`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text",
          text: response,
        },
      ],
    };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Kaggle Croissant MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
