const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jipvdeulqbfmgenjhknc.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY;

let supabase = null;
if (SUPABASE_KEY) {
  try {
    supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false }
    });
    console.log('[StorageService] Supabase Storage client initialized for URL:', SUPABASE_URL);
  } catch (err) {
    console.error('[StorageService] Failed to initialize Supabase client:', err.message);
  }
} else {
  console.log('[StorageService] SUPABASE_KEY not set. Using local disk fallback for uploads.');
}

/**
 * Upload a file to Supabase Storage (or keep local disk fallback if not configured).
 * @param {Object} file - Multer file object ({ path, filename, mimetype, originalname, buffer })
 * @param {string} bucket - Target bucket name (default: 'receipts')
 * @returns {Promise<string>} - Permanent public URL or local relative path
 */
async function uploadToStorage(file, bucket = 'receipts') {
  if (!file) return null;

  // If Supabase is configured, upload to Supabase Storage bucket
  if (supabase) {
    try {
      let fileBuffer = file.buffer;
      if (!fileBuffer && file.path && fs.existsSync(file.path)) {
        fileBuffer = fs.readFileSync(file.path);
      }

      if (fileBuffer) {
        const ext = path.extname(file.originalname || file.filename || '').toLowerCase() || '.jpg';
        const uniqueName = `proof-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;

        const { data, error } = await supabase.storage
          .from(bucket)
          .upload(uniqueName, fileBuffer, {
            contentType: file.mimetype || 'image/jpeg',
            upsert: true
          });

        if (error) {
          console.error('[StorageService] Supabase upload error:', error.message);
        } else {
          const { data: publicData } = supabase.storage
            .from(bucket)
            .getPublicUrl(uniqueName);

          if (publicData && publicData.publicUrl) {
            console.log('[StorageService] File uploaded successfully to Supabase:', publicData.publicUrl);
            return publicData.publicUrl;
          }
        }
      }
    } catch (err) {
      console.error('[StorageService] Exception during Supabase upload:', err.message);
    }
  }

  // Fallback: Local disk path
  if (file.filename) {
    return `/uploads/courts/${file.filename}`;
  }
  return null;
}

module.exports = {
  uploadToStorage,
  getSupabaseClient: () => supabase
};
