const { Pool } = require('pg');

const pool = new Pool({
    user: process.env.DB_USER || 'root',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'cheeron',
    password: process.env.DB_PASSWORD || 'root',
    port: process.env.DB_PORT || 5432,
    ssl: process.env.DB_SSL === 'true' ? {
        rejectUnauthorized: false
    } : false
});

module.exports = { pool }; 