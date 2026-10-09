// 此文件从 Rust 公开接口模式生成，请通过 npm run generate:api 更新。
export interface paths {
    "/api/v1/artifacts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;

        post: {
            parameters: {
                query: {

                    filename: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/octet-stream": string;
                };
            };
            responses: {

                201: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            created_at: number;
                            filename: string;
                            id: string;
                            media_type: string;
                            sha256: string;

                            size: number;
                        };
                    };
                };

                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                415: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/artifacts/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };

        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            created_at: number;
                            filename: string;
                            id: string;
                            media_type: string;
                            sha256: string;

                            size: number;
                        };
                    };
                };

                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/artifacts/{id}/content": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };

        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": string;
                        "application/msgpack": string;
                        "application/zip": string;
                        "image/png": string;
                    };
                };

                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                503: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/artifacts/{id}/entries": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };

        get: {
            parameters: {
                query?: {
                    offset?: number;
                    limit?: number;
                };
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            entries: {

                                compressed_size: number;
                                directory: boolean;
                                name: string;

                                size: number;
                            }[];

                            next_offset?: number | null;

                            total: number;
                        };
                    };
                };

                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/health": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };

        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            api_version: 1;

                            status: "ok";
                        };
                    };
                };

                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/jobs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };

        get: {
            parameters: {
                query?: {
                    limit?: number;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            created_at: number;
                            error?: string | null;
                            id: string;
                            input: unknown;
                            operation: string;
                            result?: unknown;

                            status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
                        }[];
                    };
                };

                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };
            };
        };
        put?: never;

        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        input: unknown;
                        operation: string;
                    };
                };
            };
            responses: {

                202: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            created_at: number;
                            error?: string | null;
                            id: string;
                            input: unknown;
                            operation: string;
                            result?: unknown;

                            status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
                        };
                    };
                };

                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                415: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/jobs/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };

        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            created_at: number;
                            error?: string | null;
                            id: string;
                            input: unknown;
                            operation: string;
                            result?: unknown;

                            status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
                        };
                    };
                };

                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/jobs/{id}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        get?: never;
        put?: never;

        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            created_at: number;
                            error?: string | null;
                            id: string;
                            input: unknown;
                            operation: string;
                            result?: unknown;

                            status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
                        };
                    };
                };

                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/jobs/{id}/events": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };

        get: {
            parameters: {
                query?: {
                    after?: number;
                };
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            job_id: string;

                            sequence: number;

                            status: "queued" | "running" | "succeeded" | "failed" | "cancelled";

                            timestamp: number;
                        }[];
                    };
                };

                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/openapi.json": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };

        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": Record<string, never>;
                    };
                };

                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v1/operations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };

        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            id: string;
                            input_schema: unknown;
                            title: string;
                        }[];
                    };
                };

                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };

                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            code: string;
                            message: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/artifacts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;

        post: {
            parameters: {
                query: {

                    filename: string;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/octet-stream": string;
                };
            };
            responses: {

                201: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {

                                created_at: number;
                                filename: string;
                                id: string;
                                media_type: string;
                                sha256: string;

                                size: number;
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                413: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                415: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                503: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/artifacts/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };

        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {

                                created_at: number;
                                filename: string;
                                id: string;
                                media_type: string;
                                sha256: string;

                                size: number;
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/artifacts/{id}/content": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };

        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": string;
                        "application/msgpack": string;
                        "application/zip": string;
                        "image/png": string;
                    };
                };

                400: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                503: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/artifacts/{id}/entries": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };

        get: {
            parameters: {
                query?: {
                    offset?: number;
                    limit?: number;
                };
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {
                                entries: {

                                    compressed_size: number;
                                    directory: boolean;
                                    name: string;

                                    size: number;
                                }[];

                                next_offset?: number | null;

                                total: number;
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/browser-plugins/{id}/assets/{path}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };

        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;

                    path: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": string;
                        "application/octet-stream": string;
                        "text/javascript": string;
                    };
                };

                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                            };
                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                            };
                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                            };
                            log_id: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;

        head: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;

                    path: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": string;
                        "application/octet-stream": string;
                        "text/javascript": string;
                    };
                };

                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                            };
                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                            };
                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                            };
                            log_id: string;
                        };
                    };
                };
            };
        };
        patch?: never;
        trace?: never;
    };
    "/api/v2/browser-plugins/{id}/runs/{run_id}/assets/{path}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };

        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;

                    path: string;

                    run_id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": string;
                        "application/octet-stream": string;
                        "text/javascript": string;
                    };
                };

                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                            };
                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                            };
                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                            };
                            log_id: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;

        head: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;

                    path: string;

                    run_id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": string;
                        "application/octet-stream": string;
                        "text/javascript": string;
                    };
                };

                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                            };
                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                            };
                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                            };
                            log_id: string;
                        };
                    };
                };
            };
        };
        patch?: never;
        trace?: never;
    };
    "/api/v2/device-actions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;

        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        capability: string;
                        device_id?: string | null;
                        generation: string;
                        input: unknown;
                        provider_id: string;

                        version: number;
                    };
                };
            };
            responses: {

                202: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {

                                created_at: number;
                                error?: string | null;
                                id: string;
                                input: unknown;
                                operation: string;
                                result?: unknown;

                                status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/device-providers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };

        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {
                                definition: {

                                    api_version: number;
                                    capabilities: {

                                        access: "read" | "write";
                                        id: string;
                                        operation: string;

                                        scope: "provider" | "device";

                                        version: number;
                                    }[];
                                    discover_operation: string;
                                    platform: string;
                                };
                                generation: string;
                                id: string;
                                version: string;
                            }[];

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/device-providers/{id}/refresh": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;

        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        generation: string;
                    };
                };
            };
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {
                                devices: {
                                    capabilities: {
                                        available: boolean;
                                        id: string;
                                        reason?: string | null;

                                        version: number;
                                    }[];
                                    model?: string | null;
                                    reference: {
                                        generation: string;
                                        local_id: string;
                                        provider_id: string;
                                    };

                                    state: "online" | "offline" | "unauthorized" | "unknown";
                                }[];
                                discovery_job_id: string;

                                observed_at: number;
                                provider: {
                                    definition: {

                                        api_version: number;
                                        capabilities: {

                                            access: "read" | "write";
                                            id: string;
                                            operation: string;

                                            scope: "provider" | "device";

                                            version: number;
                                        }[];
                                        discover_operation: string;
                                        platform: string;
                                    };
                                    generation: string;
                                    id: string;
                                    version: string;
                                };
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                502: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                504: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/devices": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };

        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {
                                devices: {
                                    capabilities: {
                                        available: boolean;
                                        id: string;
                                        reason?: string | null;

                                        version: number;
                                    }[];
                                    model?: string | null;
                                    reference: {
                                        generation: string;
                                        local_id: string;
                                        provider_id: string;
                                    };

                                    state: "online" | "offline" | "unauthorized" | "unknown";
                                }[];
                                discovery_job_id: string;

                                observed_at: number;
                                provider: {
                                    definition: {

                                        api_version: number;
                                        capabilities: {

                                            access: "read" | "write";
                                            id: string;
                                            operation: string;

                                            scope: "provider" | "device";

                                            version: number;
                                        }[];
                                        discover_operation: string;
                                        platform: string;
                                    };
                                    generation: string;
                                    id: string;
                                    version: string;
                                };
                            }[];

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/diagnostics/logging": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };

        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {

                                dropped_records: number;

                                oversized_records: number;

                                queue_capacity: number;

                                record_limit_bytes: number;

                                write_errors: number;

                                written_bytes: number;
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/health": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };

        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            data: {

                                api_version: 2;

                                status: "ok";
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/jobs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };

        get: {
            parameters: {
                query?: {
                    limit?: number;
                };
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {

                                created_at: number;
                                error?: string | null;
                                id: string;
                                input: unknown;
                                operation: string;
                                result?: unknown;

                                status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
                            }[];

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        put?: never;

        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/json": {
                        input: unknown;
                        operation: string;
                    };
                };
            };
            responses: {

                202: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {

                                created_at: number;
                                error?: string | null;
                                id: string;
                                input: unknown;
                                operation: string;
                                result?: unknown;

                                status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                413: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                415: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/jobs/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };

        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {

                                created_at: number;
                                error?: string | null;
                                id: string;
                                input: unknown;
                                operation: string;
                                result?: unknown;

                                status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/jobs/{id}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        get?: never;
        put?: never;

        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {

                                created_at: number;
                                error?: string | null;
                                id: string;
                                input: unknown;
                                operation: string;
                                result?: unknown;

                                status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/jobs/{id}/events": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };

        get: {
            parameters: {
                query?: {
                    after?: number;
                };
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {
                                job_id: string;

                                sequence: number;

                                status: "queued" | "running" | "succeeded" | "failed" | "cancelled";

                                timestamp: number;
                            }[];

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/openapi.json": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };

        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": Record<string, never>;
                    };
                };

                400: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/operations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };

        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {
                                id: string;
                                input_schema: unknown;
                                title: string;
                            }[];

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {

                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/plugin-packages/{kind}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };

        get: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    kind: "server" | "browser";
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {

                                api_version?: number | null;
                                entry_path: string;
                                entry_url?: string | null;
                                id: string;

                                installed_at: number;

                                kind: "server" | "browser";
                                runtime: string;
                                version: string;
                            }[];

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        put?: never;

        post: {
            parameters: {
                query: {
                    format: "zip" | "tgz";
                };
                header?: never;
                path: {
                    kind: "server" | "browser";
                };
                cookie?: never;
            };
            requestBody: {
                content: {
                    "application/gzip": string;
                    "application/zip": string;
                };
            };
            responses: {

                201: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {

                                api_version?: number | null;
                                entry_path: string;
                                entry_url?: string | null;
                                id: string;

                                installed_at: number;

                                kind: "server" | "browser";
                                runtime: string;
                                version: string;
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                413: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                            };
                            log_id: string;
                        };
                    };
                };

                415: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            error: {
                                code: string;
                                message: string;
                            };
                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/plugin-packages/{kind}/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;

        delete: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    kind: "server" | "browser";
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {

                                api_version?: number | null;
                                entry_path: string;
                                entry_url?: string | null;
                                id: string;

                                installed_at: number;

                                kind: "server" | "browser";
                                runtime: string;
                                version: string;
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/plugins": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };

        get: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {
                                cleanup_failed: boolean;
                                generation: string;
                                id: string;
                                operations: string[];
                                protected: boolean;

                                state: "loaded" | "draining" | "unloaded";
                                version: string;
                            }[];

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/plugins/{id}/load": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        get?: never;
        put?: never;

        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {
                                cleanup_failed: boolean;
                                generation: string;
                                id: string;
                                operations: string[];
                                protected: boolean;

                                state: "loaded" | "draining" | "unloaded";
                                version: string;
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                503: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                504: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/plugins/{id}/unload": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        get?: never;
        put?: never;

        post: {
            parameters: {
                query?: never;
                header?: never;
                path: {
                    id: string;
                };
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            data: {
                                cleanup_failed: boolean;
                                generation: string;
                                id: string;
                                operations: string[];
                                protected: boolean;

                                state: "loaded" | "draining" | "unloaded";
                                version: string;
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                503: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                504: {
                    headers: {
                        "x-deviceforge-log-id"?: string;
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/api/v2/system/shutdown": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;

        post: {
            parameters: {
                query?: never;
                header?: never;
                path?: never;
                cookie?: never;
            };
            requestBody?: never;
            responses: {

                200: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {
                            data: {
                                stopping: boolean;
                            };

                            log_id: string;
                        };
                    };
                };

                400: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                401: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                404: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                409: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                429: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };

                500: {
                    headers: {
                        [name: string]: unknown;
                    };
                    content: {
                        "application/json": {

                            error: {
                                code: string;
                                message: string;
                            };

                            log_id: string;
                        };
                    };
                };
            };
        };
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {

        ApksInstalled: {
            artifact_id: string;
            device_id: string;
            installed: boolean;
        };

        BuildApksRequest: {
            artifact_id: string;

            mode: "default" | "universal";
        };

        BuiltApks: {

            apk_count: number;
            artifact: {

                created_at: number;
                filename: string;
                id: string;
                media_type: string;
                sha256: string;

                size: number;
            };

            mode: "default" | "universal";
            source_artifact_id: string;
            universal_entry?: string | null;
        };

        DecodedPackage: {
            artifact: {

                created_at: number;
                filename: string;
                id: string;
                media_type: string;
                sha256: string;

                size: number;
            };

            files: number;
            source_artifact_id: string;

            unpacked_size: number;
        };

        DeviceActionRequest: {
            capability: string;
            device_id?: string | null;
            generation: string;
            input: unknown;
            provider_id: string;

            version: number;
        };

        DeviceDirectory: {
            devices: {
                capabilities: {
                    available: boolean;
                    id: string;
                    reason?: string | null;

                    version: number;
                }[];
                model?: string | null;
                reference: {
                    generation: string;
                    local_id: string;
                    provider_id: string;
                };

                state: "online" | "offline" | "unauthorized" | "unknown";
            }[];
            discovery_job_id: string;

            observed_at: number;
            provider: {
                definition: {

                    api_version: number;
                    capabilities: {

                        access: "read" | "write";
                        id: string;
                        operation: string;

                        scope: "provider" | "device";

                        version: number;
                    }[];
                    discover_operation: string;
                    platform: string;
                };
                generation: string;
                id: string;
                version: string;
            };
        };

        DeviceProviderInfo: {
            definition: {

                api_version: number;
                capabilities: {

                    access: "read" | "write";
                    id: string;
                    operation: string;

                    scope: "provider" | "device";

                    version: number;
                }[];
                discover_operation: string;
                platform: string;
            };
            generation: string;
            id: string;
            version: string;
        };

        ErrorResponse: {
            error: {
                code: string;
                message: string;
            };
            log_id: string;
        };

        ExtractedApk: {
            artifact: {

                created_at: number;
                filename: string;
                id: string;
                media_type: string;
                sha256: string;

                size: number;
            };
            entry: string;
            source_artifact_id: string;
        };

        ExtractedSplits: {
            apk_entries: string[];
            artifact: {

                created_at: number;
                filename: string;
                id: string;
                media_type: string;
                sha256: string;

                size: number;
            };

            device_spec: {

                screen_density: number;

                sdk_version: number;
                supported_abis: string[];
                supported_locales: string[];
            };
            source_artifact_id: string;
        };

        InputReceipt: {
            action: string;
            device_id: string;
            dispatched: boolean;
        };

        InputRequest: {

            action: {

                kind: "tap";

                x: number;

                y: number;
            } | {

                duration_ms: number;

                kind: "swipe";

                x1: number;

                x2: number;

                y1: number;

                y2: number;
            } | {

                key_code: number;

                kind: "keyevent";

                long_press: boolean;
            } | {

                enter: boolean;

                kind: "text";
                text: string;
            };
            device_id: string;
        };

        JobResponse: {
            data: {

                created_at: number;
                error?: string | null;
                id: string;
                input: unknown;
                operation: string;
                result?: unknown;

                status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
            };
            log_id: string;
        };

        PackageManifest: {
            application_label?: string | null;
            artifact_id: string;
            debuggable?: boolean | null;

            format: "apk" | "aab";
            min_sdk?: string | null;
            module?: string | null;
            package_name: string;
            permissions: string[];
            target_sdk?: string | null;
            version_code?: string | null;
            version_name?: string | null;
            xml: string;
        };

        PackageSignature: {
            artifact_id: string;
            report: string;
            schemes: {
                scheme: string;
                verified: boolean;
            }[];
            signers: {
                certificate_sha256: string;
                distinguished_name?: string | null;

                number: number;
            }[];
            verified: boolean;
        };

        PerformancePage: {

            next_after: number;
            readings: {

                captured_at: number;

                cpu_core_percent?: number | null;

                cpu_share_percent?: number | null;

                fps?: number | null;
                frame_window?: {

                    duration_ms: number;

                    frames: number;
                    source: string;
                } | null;

                logical_cpus: number;

                pid: number;

                pss_kib: number;

                rss_kib?: number | null;

                sequence: number;
            }[];
            session: {
                error?: string | null;
                id: string;
                request: {

                    duration_secs: number;

                    interval_ms: number;
                    target: {
                        device_id: string;
                        package: string;
                    };
                };

                revision: number;

                samples: number;

                started_at: number;

                state: "running" | "paused" | "stopped" | "completed" | "failed" | "interrupted";

                updated_at: number;
            };
        };

        PerformanceSession: {
            error?: string | null;
            id: string;
            request: {

                duration_secs: number;

                interval_ms: number;
                target: {
                    device_id: string;
                    package: string;
                };
            };

            revision: number;

            samples: number;

            started_at: number;

            state: "running" | "paused" | "stopped" | "completed" | "failed" | "interrupted";

            updated_at: number;
        };

        PerformanceSessions: {
            next_after_id?: string | null;
            sessions: {
                error?: string | null;
                id: string;
                request: {

                    duration_secs: number;

                    interval_ms: number;
                    target: {
                        device_id: string;
                        package: string;
                    };
                };

                revision: number;

                samples: number;

                started_at: number;

                state: "running" | "paused" | "stopped" | "completed" | "failed" | "interrupted";

                updated_at: number;
            }[];
        };

        PluginArtifactResult: {
            artifacts: {

                created_at: number;
                filename: string;
                id: string;
                media_type: string;
                sha256: string;

                size: number;
            }[];
            result: unknown;
        };

        PluginPackageFormat: "zip" | "tgz";

        PluginPackageInfo: {

            api_version?: number | null;
            entry_path: string;
            entry_url?: string | null;
            id: string;

            installed_at: number;

            kind: "server" | "browser";
            runtime: string;
            version: string;
        };

        PluginPackageKind: "server" | "browser";

        ProviderInput: {
            generation: string;
            id: string;
        };

        SdkScan: {
            artifact_id: string;
            findings: {
                class_found?: boolean | null;
                evidence: string[];
                package_found: boolean;
                rule: {
                    class_name?: string | null;
                    name: string;
                    package_path: string;
                };
            }[];
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export type operations = Record<string, never>;
