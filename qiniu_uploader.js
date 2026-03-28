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
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const uuid_1 = require("uuid");
const qiniu = __importStar(require("qiniu"));
const config = __importStar(require("./config"));
const logger_1 = require("./logger");
// 全局配置
let qiniuConfig = null;
let uploadToken = null;
let tokenExpireTime = 0;
/**
 * 初始化七牛配置
 */
function initQiniuConfig() {
    if (qiniuConfig) {
        return qiniuConfig;
    }
    const accessKey = config.QINIU_ACCESS_KEY;
    const secretKey = config.QINIU_SECRET_KEY;
    if (!accessKey || !secretKey) {
        logger_1.logger.error('❌ 七牛云配置缺失，请检查 config.ts');
        return null;
    }
    try {
        qiniuConfig = new qiniu.conf.Config();
        // 根据 zone 配置选择存储区域
        const zone = config.QINIU_ZONE || 'z0';
        switch (zone) {
            case 'z0':
                qiniuConfig.zone = qiniu.zone.Zone_z0; // 华东
                break;
            case 'z1':
                qiniuConfig.zone = qiniu.zone.Zone_z1; // 华北
                break;
            case 'z2':
                qiniuConfig.zone = qiniu.zone.Zone_z2; // 华南
                break;
            case 'na0':
                qiniuConfig.zone = qiniu.zone.Zone_na0; // 北美
                break;
            case 'as0':
                qiniuConfig.zone = qiniu.zone.Zone_as0; // 东南亚
                break;
            default:
                qiniuConfig.zone = qiniu.zone.Zone_z0;
        }
        logger_1.logger.info(`✅ 七牛云配置初始化成功 (zone: ${zone})`);
        return qiniuConfig;
    }
    catch (e) {
        logger_1.logger.error(`❌ 七牛云配置初始化失败: ${e}`);
        return null;
    }
}
/**
 * 获取上传凭证 (带缓存，避免频繁生成)
 */
function getUploadToken() {
    const now = Date.now();
    // 如果 token 还有 5 分钟以上有效期，直接复用
    if (uploadToken && tokenExpireTime - now > 5 * 60 * 1000) {
        return uploadToken;
    }
    const accessKey = config.QINIU_ACCESS_KEY;
    const secretKey = config.QINIU_SECRET_KEY;
    const bucket = config.QINIU_BUCKET;
    if (!accessKey || !secretKey || !bucket) {
        logger_1.logger.error('❌ 七牛云配置缺失');
        return null;
    }
    try {
        const mac = new qiniu.auth.digest.Mac(accessKey, secretKey);
        const options = {
            scope: bucket,
            expires: 7200, // 2小时有效期
        };
        const putPolicy = new qiniu.rs.PutPolicy(options);
        uploadToken = putPolicy.uploadToken(mac);
        tokenExpireTime = now + 7200 * 1000;
        logger_1.logger.info('✅ 七牛云上传凭证已生成');
        return uploadToken;
    }
    catch (e) {
        logger_1.logger.error(`❌ 生成七牛云上传凭证失败: ${e}`);
        return null;
    }
}
/**
 * 上传文件到七牛云
 *
 * @param filePath - 本地文件路径
 * @param objectKey - 七牛云中的文件路径。如果为 undefined，自动生成唯一路径
 * @returns 七牛云 object key，失败返回 null
 */
async function uploadFile(filePath, objectKey) {
    const qnConfig = initQiniuConfig();
    if (!qnConfig) {
        return null;
    }
    const token = getUploadToken();
    if (!token) {
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
        objectKey = `${config.QINIU_PREFIX}${uniqueName}`;
    }
    try {
        const fileSize = fs.statSync(filePath).size;
        logger_1.logger.info(`☁️ 七牛云上传中: ${filePath} (${(fileSize / 1024 / 1024).toFixed(1)}MB) -> ${objectKey}`);
        const formUploader = new qiniu.form_up.FormUploader(qnConfig);
        const putExtra = new qiniu.form_up.PutExtra();
        return new Promise((resolve) => {
            formUploader.putFile(token, objectKey, filePath, putExtra, (err, body, info) => {
                if (err) {
                    logger_1.logger.error(`❌ 七牛云上传失败: ${err.message}`);
                    resolve(null);
                    return;
                }
                if (info.statusCode === 200) {
                    logger_1.logger.info(`✅ 七牛云上传成功！Key: ${objectKey}, Hash: ${body.hash}`);
                    resolve(objectKey);
                }
                else {
                    logger_1.logger.error(`❌ 七牛云上传失败: HTTP ${info.statusCode}`);
                    resolve(null);
                }
            });
        });
    }
    catch (e) {
        logger_1.logger.error(`❌ 七牛云上传异常: ${e.message || e}`);
        return null;
    }
}
/**
 * 获取文件的公开访问 URL
 */
function getPublicUrl(objectKey) {
    const domain = config.QINIU_DOMAIN;
    if (!domain) {
        logger_1.logger.warn('⚠️ 七牛云域名未配置，返回空URL');
        return '';
    }
    return `${domain}/${objectKey}`;
}
// 测试代码
if (require.main === module) {
    (async () => {
        const testFile = 'test_qiniu_upload.txt';
        fs.writeFileSync(testFile, 'Hello Qiniu from SeeDance Worker!');
        const key = await uploadFile(testFile);
        if (key) {
            console.log(`✅ 测试上传成功！七牛云 Key: ${key}`);
            const url = getPublicUrl(key);
            if (url) {
                console.log(`   公开URL: ${url}`);
            }
        }
        else {
            console.log('❌ 测试上传失败');
        }
        if (fs.existsSync(testFile)) {
            fs.unlinkSync(testFile);
        }
    })();
}
