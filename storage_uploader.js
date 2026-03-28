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
Object.defineProperty(exports, "__esModule", { value: true });
exports.uploadFile = uploadFile;
exports.getPublicUrl = getPublicUrl;
exports.isConfigured = isConfigured;
exports.getStorageType = getStorageType;
exports.isEnabled = isEnabled;
const config = __importStar(require("./config"));
const logger_1 = require("./logger");
const cosUploader = __importStar(require("./cos_uploader"));
const ossUploader = __importStar(require("./oss_uploader"));
const qiniuUploader = __importStar(require("./qiniu_uploader"));
/**
 * 统一云存储上传器
 * 根据配置自动选择 COS / OSS / 七牛云
 */
/**
 * 上传文件到云存储
 *
 * @param filePath - 本地文件路径
 * @param objectKey - 云存储中的文件路径 (可选，自动生成)
 * @returns 上传成功返回 object key，失败返回 null
 */
async function uploadFile(filePath, objectKey) {
    // 检查是否开启云存储
    if (!config.ENABLE_CLOUD_STORAGE) {
        logger_1.logger.info('📦 云存储未开启 (ENABLE_CLOUD_STORAGE=false)');
        return null;
    }
    const storageType = config.STORAGE_TYPE;
    logger_1.logger.info(`📦 使用 ${storageType.toUpperCase()} 存储服务上传文件...`);
    switch (storageType) {
        case 'cos':
            return cosUploader.uploadFile(filePath, objectKey);
        case 'oss':
            return ossUploader.uploadFile(filePath, objectKey);
        case 'qiniu':
            return qiniuUploader.uploadFile(filePath, objectKey);
        default:
            logger_1.logger.error(`❌ 未知的存储类型: ${storageType}`);
            return null;
    }
}
/**
 * 获取文件的公开访问 URL
 *
 * @param objectKey - 云存储中的文件 key
 * @returns 公开访问 URL
 */
function getPublicUrl(objectKey) {
    if (!config.ENABLE_CLOUD_STORAGE) {
        return '';
    }
    const storageType = config.STORAGE_TYPE;
    switch (storageType) {
        case 'cos':
            // COS 使用预签名 URL，由服务端生成
            return `cos://${config.COS_BUCKET}/${objectKey}`;
        case 'oss':
            return ossUploader.getPublicUrl(objectKey);
        case 'qiniu':
            return qiniuUploader.getPublicUrl(objectKey);
        default:
            return '';
    }
}
/**
 * 检查云存储是否已正确配置
 */
function isConfigured() {
    if (!config.ENABLE_CLOUD_STORAGE) {
        return false;
    }
    const storageType = config.STORAGE_TYPE;
    switch (storageType) {
        case 'cos':
            return !!(config.COS_SECRET_ID && config.COS_SECRET_KEY && config.COS_BUCKET);
        case 'oss':
            return !!(config.OSS_ACCESS_KEY_ID && config.OSS_ACCESS_KEY_SECRET && config.OSS_BUCKET);
        case 'qiniu':
            return !!(config.QINIU_ACCESS_KEY && config.QINIU_SECRET_KEY && config.QINIU_BUCKET);
        default:
            return false;
    }
}
/**
 * 获取当前存储类型
 */
function getStorageType() {
    return config.STORAGE_TYPE;
}
/**
 * 是否开启云存储
 */
function isEnabled() {
    return config.ENABLE_CLOUD_STORAGE;
}
