const { expect } = require('chai');
const jsonConfig = require('../admin/jsonConfig.json');
const ioPackage = require('../io-package.json');
const en = require('../admin/i18n/en.json');

const LANGUAGES = ['en', 'de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'];

describe('admin config', () => {
    it('every setting with a default is pre-set in io-package native', () => {
        for (const [name, item] of Object.entries(jsonConfig.items)) {
            if (item.default === undefined) {
                continue;
            }
            expect(ioPackage.native, `native.${name} is missing`).to.have.property(name);
            expect(ioPackage.native[name], `native.${name} differs from the jsonConfig default`).to.equal(
                item.default,
            );
        }
    });

    it('every label and help text is translated into all supported languages', () => {
        const texts = [];
        for (const item of Object.values(jsonConfig.items)) {
            // Option labels carry noTranslation, so only the field texts are checked here.
            for (const key of ['label', 'help', 'validatorErrorText']) {
                if (item[key]) {
                    texts.push(item[key]);
                }
            }
        }
        expect(texts).to.not.be.empty;

        for (const lang of LANGUAGES) {
            const translations = require(`../admin/i18n/${lang}.json`);
            for (const text of texts) {
                expect(translations, `${lang}.json has no entry for "${text}"`).to.have.property(text);
                expect(translations[text], `${lang}.json leaves "${text}" empty`).to.be.a('string').and.not.empty;
            }
        }
        // en.json maps every text onto itself - a mismatch means the source text drifted.
        for (const text of texts) {
            expect(en[text], `en.json translates "${text}" to something else`).to.equal(text);
        }
    });
});
