"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.uploadFile = uploadFile;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const uuid_1 = require("uuid");
const cos_nodejs_sdk_v5_1 = __importDefault(require("cos-nodejs-sdk-v5"));
const config = __importStar(require("./config"));
const logger_1 = require("./logger");
// 全局 COS 客户端 (复用连接)
let cosClient = null;
/**
 * 初始化并返回 COS 客户端 (单例)
 */
function getCosClient() {
    if (cosClient) {
        return cosClient;
    }
    const secretId = config.COS_SECRET_ID;
    const secretKey = config.COS_SECRET_KEY;
    const region = config.COS_REGION;
    if (!secretId || !secretKey || !region) {
        logger_1.logger.error('❌ COS 配置缺失，请检查 config.ts');
        return null;
    }
    try {
        cosClient = new cos_nodejs_sdk_v5_1.default({
            SecretId: secretId,
            SecretKey: secretKey,
        });
        logger_1.logger.info('✅ COS 客户端初始化成功');
        return cosClient;
    }
    catch (e) {
        logger_1.logger.error(`❌ COS 客户端初始化失败: ${e}`);
        return null;
    }
}
/**
 * 上传文件到腾讯云 COS
 *
 * @param filePath - 本地文件路径
 * @param objectKey - COS 中的文件路径。如果为 undefined，自动生成唯一路径
 * @returns COS object key (不是URL！URL 由总服务器在客户端请求时实时生成预签名链接)
 *          失败返回 null
 */
async function uploadFile(filePath, objectKey) {
    const client = getCosClient();
    if (!client) {
        return null;
    }
    if (!fs.existsSync(filePath)) {
        logger_1.logger.error(`❌ 文件不存在: ${filePath}`);
        return null;
    }
    const bucket = config.COS_BUCKET;
    if (!bucket) {
        logger_1.logger.error('❌ COS Bucket 未配置');
        return null;
    }
    // 自动生成唯一的 object key: seedance/uuid.mp4
    if (!objectKey) {
        const ext = path.extname(filePath) || '.mp4';
        const uniqueName = `${(0, uuid_1.v4)().replace(/-/g, '')}${ext}`;
        objectKey = `${config.COS_PREFIX}${uniqueName}`;
    }
    try {
        const fileSize = fs.statSync(filePath).size;
        logger_1.logger.info(`☁️ 上传中: ${filePath} (${(fileSize / 1024 / 1024).toFixed(1)}MB) -> ${objectKey}`);
        const result = await new Promise((resolve, reject) => {
            client.putObject({
                Bucket: bucket,
                Region: config.COS_REGION,
                Key: objectKey,
                Body: fs.createReadStream(filePath),
            }, (err, data) => {
                if (err) {
                    reject(err);
                }
                else {
                    resolve(data);
                }
            });
        });
        const etag = result.ETag || 'N/A';
        logger_1.logger.info(`✅ 上传成功！Key: ${objectKey}, ETag: ${etag}`);
        // 返回 COS key，不返回 URL
        // URL 由总服务器在客户端轮询时实时生成预签名链接 (更安全，有效期可控)
        return objectKey;
    }
    catch (e) {
        if (e.code) {
            logger_1.logger.error(`❌ COS 服务错误: ${e.code} - ${e.message}`);
        }
        else {
            logger_1.logger.error(`❌ 上传异常: ${e}`);
        }
        return null;
    }
}
// 测试代码
if (require.main === module) {
    (async () => {
        const testFile = 'test_upload.txt';
        fs.writeFileSync(testFile, 'Hello COS from SeeDance Worker!');
        const key = await uploadFile(testFile);
        if (key) {
            console.log(`✅ 测试上传成功！COS Key: ${key}`);
        }
        else {
            console.log('❌ 测试上传失败');
        }
        if (fs.existsSync(testFile)) {
            fs.unlinkSync(testFile);
        }
    })();
}
