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
exports.getPublicUrl = getPublicUrl;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const uuid_1 = require("uuid");
const ali_oss_1 = __importDefault(require("ali-oss"));
const config = __importStar(require("./config"));
const logger_1 = require("./logger");
// 全局 OSS 客户端 (复用连接)
let ossClient = null;
/**
 * 初始化并返回 OSS 客户端 (单例)
 */
function getOssClient() {
    if (ossClient) {
        return ossClient;
    }
    const accessKeyId = config.OSS_ACCESS_KEY_ID;
    const accessKeySecret = config.OSS_ACCESS_KEY_SECRET;
    const region = config.OSS_REGION;
    const bucket = config.OSS_BUCKET;
    if (!accessKeyId || !accessKeySecret || !region || !bucket) {
        logger_1.logger.error('❌ OSS 配置缺失，请检查 config.ts');
        return null;
    }
    try {
        ossClient = new ali_oss_1.default({
            region,
            accessKeyId,
            accessKeySecret,
            bucket,
        });
        logger_1.logger.info('✅ OSS 客户端初始化成功');
        return ossClient;
    }
    catch (e) {
        logger_1.logger.error(`❌ OSS 客户端初始化失败: ${e}`);
        return null;
    }
}
/**
 * 上传文件到阿里云 OSS
 *
 * @param filePath - 本地文件路径
 * @param objectKey - OSS 中的文件路径。如果为 undefined，自动生成唯一路径
 * @returns OSS object key，失败返回 null
 */
async function uploadFile(filePath, objectKey) {
    const client = getOssClient();
    if (!client) {
        return null;
    }
    if (!fs.existsSync(filePath)) {
        logger_1.logger.error(`❌ 文件不存在: ${filePath}`);
        return null;
    }
    // 自动生成唯一的 object key: seedance/uuid.mp4
    if (!objectKey) {
        const ext = path.extname(filePath) || '.mp4';
        const uniqueName = `${(0, uuid_1.v4)().replace(/-/g, '')}${ext}`;
        objectKey = `${config.OSS_PREFIX}${uniqueName}`;
    }
    try {
        const fileSize = fs.statSync(filePath).size;
        logger_1.logger.info(`☁️ OSS 上传中: ${filePath} (${(fileSize / 1024 / 1024).toFixed(1)}MB) -> ${objectKey}`);
        const result = await client.put(objectKey, filePath);
        logger_1.logger.info(`✅ OSS 上传成功！Key: ${objectKey}, ETag: ${result.res.headers['etag'] || 'N/A'}`);
        return objectKey;
    }
    catch (e) {
        logger_1.logger.error(`❌ OSS 上传异常: ${e.message || e}`);
        return null;
    }
}
/**
 * 获取文件的公开访问 URL
 */
function getPublicUrl(objectKey) {
    const bucket = config.OSS_BUCKET;
    const region = config.OSS_REGION;
    return `https://${bucket}.${region}.aliyuncs.com/${objectKey}`;
}
// 测试代码
if (require.main === module) {
    (async () => {
        const testFile = 'test_oss_upload.txt';
        fs.writeFileSync(testFile, 'Hello OSS from SeeDance Worker!');
        const key = await uploadFile(testFile);
        if (key) {
            console.log(`✅ 测试上传成功！OSS Key: ${key}`);
            console.log(`   公开URL: ${getPublicUrl(key)}`);
        }
        else {
            console.log('❌ 测试上传失败');
        }
        if (fs.existsSync(testFile)) {
            fs.unlinkSync(testFile);
        }
    })();
}
