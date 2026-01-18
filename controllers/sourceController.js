'use strict';

const supabase = require('../services/data/supabase');
const cloudinary = require('../config/cloudinary');
const logger = require('../utils/logger');
const fs = require('fs');

class SourceManager {
    async uploadSource(userId, lessonId, filePath, displayName, description, mimeType, originalFileName) {
        try {
            logger.info(`📤 Uploading source [${displayName}]...`);

            let resourceType = 'raw';
            if (mimeType.startsWith('image/')) resourceType = 'image';
            else if (mimeType.startsWith('video/')) resourceType = 'video';

            const uploadResult = await cloudinary.uploader.upload(filePath, {
                folder: 'eduapp_sources',
                resource_type: resourceType,
                use_filename: true,
                public_id: `user_${userId}_${Date.now()}`,
                type: 'upload',
                access_mode: 'public'
            });

            const simpleType = mimeType.split('/')[0] === 'image' ? 'image' : 'document';

            const insertData = {
                user_id: userId,
                lesson_id: lessonId || null,
                file_url: uploadResult.secure_url,
                file_type: simpleType,
                file_name: displayName,
                description: description,
                original_file_name: originalFileName,
                public_id: uploadResult.public_id,
                processed: true,
                status: 'completed',
                extracted_text: null
            };

            const { data, error } = await supabase
                .from('lesson_sources')
                .insert(insertData)
                .select()
                .single();

            if (error) throw error;
            return data;

        } catch (err) {
            logger.error('❌ Source Upload Failed:', err.message);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            throw err;
        }
    }

    async getSourcesByLesson(userId, lessonId) {
        const { data, error } = await supabase
            .from('lesson_sources')
            .select('*')
            .eq('lesson_id', lessonId)
            .eq('user_id', userId)
            .order('created_at', { ascending: false });

        if (error) {
            logger.error('Get Sources Error:', error.message);
            return [];
        }
        return data;
    }

    async deleteSource(userId, sourceId) {
        const { data: source } = await supabase
            .from('lesson_sources')
            .select('public_id, user_id')
            .eq('id', sourceId)
            .single();

        if (!source) throw new Error('Source not found');
        if (source.user_id !== userId) throw new Error('Unauthorized');

        if (source.public_id) {
            await cloudinary.uploader.destroy(source.public_id, { resource_type: 'raw' });
        }

        const { error } = await supabase.from('lesson_sources').delete().eq('id', sourceId);
        if (error) throw error;

        logger.info(`🗑️ Source deleted: ${sourceId}`);
        return true;
    }
}

// --- الدوال المساعدة (خارج الكلاس تماماً) ---

function parseSizeToBytes(sizeStr) {
    if (!sizeStr || typeof sizeStr !== 'string') return 0;
    const units = { 'bytes': 1, 'kb': 1024, 'mb': 1024 * 1024, 'gb': 1024 * 1024 * 1024 };
    const match = sizeStr.toLowerCase().match(/([\d.]+)\s*(bytes|kb|mb|gb)/);
    if (!match) return 0;
    const value = parseFloat(match[1]);
    const unit = match[2];
    return value * (units[unit] || 1);
}

function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// التصدير الصحيح (Exporting an object containing everything)
const managerInstance = new SourceManager();

module.exports = managerInstance; // التصدير الافتراضي هو الـ instance
module.exports.parseSizeToBytes = parseSizeToBytes;
module.exports.formatBytes = formatBytes;
