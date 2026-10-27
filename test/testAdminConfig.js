const { expect } = require('chai');
/** @type {{ items: Record<string, Record<string, any>> }} */
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


describe('cloud Admin configuration contract', () => {
    it('offers generic Cloud without changing local defaults', () => {
        expect(jsonConfig.items.protocol.options.find(option => option.value === 'cloud').label).to.equal('Philips Cloud');
        expect(ioPackage.native.protocol).to.equal('coap');
        expect(ioPackage.native.model).to.equal('Generic');
        expect(ioPackage.native.cloudCountry).to.equal('');
        expect(jsonConfig.items.cloudCountry.default).to.equal('');
        const countryValid = new Function('data', `return (${jsonConfig.items.cloudCountry.validator});`);
        expect(countryValid({ protocol: 'cloud', cloudCountry: '' })).to.equal(false);
        expect(countryValid({ protocol: 'cloud', cloudCountry: 'DE' })).to.equal(true);
        expect(countryValid({ protocol: 'coap', cloudCountry: '' })).to.equal(true);
        const validate = new Function('data', `return (${jsonConfig.items.host.validator});`);
        expect(validate({ protocol: 'cloud', host: '' })).to.equal(true);
        expect(validate({ protocol: 'coap', host: '' })).to.equal(false);
        expect(validate({ protocol: 'http', host: 'synthetic.invalid' })).to.equal(true);
        expect(jsonConfig.items).not.to.have.property('_cloudRedirect');
        expect(jsonConfig.items).not.to.have.property('_cloudComplete');
        expect(jsonConfig.items).not.to.have.property('_cloudLogin');
        expect(jsonConfig.items._cloudRequestCode.command).to.equal('cloudRequestCode');
        expect(jsonConfig.items._cloudConfirmCode.command).to.equal('cloudConfirmCode');
        expect(jsonConfig.items._cloudConfirmCode.reloadBrowser).to.equal(true);
        expect(ioPackage.native).not.to.have.property('_cloudCode');
        expect(ioPackage.native.cloudEmail).to.equal('');
        expect(jsonConfig.items.cloudEmail.type).to.equal('text');
        const email = 'test"\\@example.invalid';
        const data = { cloudEmail: email, _cloudCode: '012345' };
        for (const [item, expected] of Object.entries({ _cloudRequestCode: { email }, _cloudConfirmCode: { code: '012345' } })) {
            const interpolate = new Function('data', `return \`${jsonConfig.items[item].jsonData}\`;`);
            expect(JSON.parse(interpolate(data))).to.deep.equal(expected);
        }
        expect(jsonConfig.items).not.to.have.property('_cloudReload');
        expect(jsonConfig.items._cloudStatus.type).to.equal('textSendTo');
        expect(jsonConfig.items._cloudStatus.command).to.equal('cloudLoginStatus');
        const statusData = new Function('_system', `return \`${jsonConfig.items._cloudStatus.jsonData}\`;`);
        expect(JSON.parse(statusData({ language: 'de' }))).to.deep.equal({ language: 'de' });
        expect(jsonConfig.items).not.to.have.property('cloudDeviceId');
        for (const secret of ioPackage.encryptedNative) {
            expect(ioPackage.protectedNative).to.include(secret);
            expect(jsonConfig.items).not.to.have.property(secret);
        }
    });
});
