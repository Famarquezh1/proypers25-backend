#!/usr/bin/env node

/**
 * Script para corregir todos los errores de sintaxis de optional chaining en shadowEdgeSamplerDiagnostic.js
 */

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'backend', 'lib', 'shadowEdgeSamplerDiagnostic.js');

function fixOptionalChainingErrors(content) {
    // Corregir espacios en optional chaining
    content = content.replace(/\?\s+\./g, '?.');

    // Corregir espacios en nullish coalescing
    content = content.replace(/\?\s+\?/g, '??');

    return content;
}

try {
    console.log('🔧 Corrigiendo errores de sintaxis en shadowEdgeSamplerDiagnostic.js...');

    const originalContent = fs.readFileSync(filePath, 'utf8');
    const fixedContent = fixOptionalChainingErrors(originalContent);

    // Contar cambios
    const originalMatches = (originalContent.match(/\?\s+\./g) || []).length + (originalContent.match(/\?\s+\?/g) || []).length;
    const fixedMatches = (fixedContent.match(/\?\s+\./g) || []).length + (fixedContent.match(/\?\s+\?/g) || []).length;

    if (originalMatches === 0) {
        console.log('✅ No se encontraron errores de sintaxis');
        process.exit(0);
    }

    fs.writeFileSync(filePath, fixedContent);

    console.log(`✅ Archivo corregido: ${originalMatches} errores de sintaxis fijados`);
    console.log(`📍 Errores restantes: ${fixedMatches}`);

    if (fixedMatches > 0) {
        console.log('⚠️  Aún quedan errores sin corregir');
    }

    process.exit(0);

} catch (error) {
    console.error('❌ Error corrigiendo archivo:', error);
    process.exit(1);
}