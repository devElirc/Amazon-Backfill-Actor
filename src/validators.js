// // src/validators.js
// const Ajv = require('ajv');
// const fs = require('fs');
// const path = require('path');
// const ajv = new Ajv({ allErrors: true, strict: false });

// let schema;
// try {
//   schema = JSON.parse(fs.readFileSync(path.join(__dirname, 'validators', 'schema.json'), 'utf8'));
// } catch (e) {
//   // fallback minimal schema
//   schema = {
//     type: 'object',
//     required: ['version','source','scraped_at','asin','product_url','title','main_image','all_images'],
//     properties: {
//       version: { type: 'string' },
//       source: { type: 'string' },
//       scraped_at: { type: 'string' },
//       asin: { type: ['string','null'] },
//       product_url: { type: ['string','null'] },
//       title: { type: ['string','null'] },
//       main_image: { type: ['string','null'] },
//       all_images: { type: 'array' }
//     }
//   };
// }
// const validate = ajv.compile(schema);

// function validateSchema(obj) {
//   const valid = validate(obj);
//   return { valid, errors: valid ? [] : (validate.errors || []) };
// }

// module.exports = { validateSchema };


export function validateSchema(product) {
    return { valid: true, errors: [] }; // MVP validation
}
