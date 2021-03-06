import * as store from '../store';
import HateoasModel from '../models/hateoas-model';
import Permissions from './permissions';
import PhoneHomeRequestBodyBuilder from '../phone-home/builder';
import PhoneHomeClient from '../phone-home/client';

class Hub {
    getOrigin() {
        return store.getState('hubOrigin') || '';
    }

    async login({ username, password }) {
        const origin = this.getOrigin();

        if (!origin) {
            throw new Error('No Hub origin saved');
        }

        // This permissions request will throw if it fails
        await Permissions.requestUrl(origin);

        return this.post('/j_spring_security_check', {
            fetchOpts: {
                headers: {
                    'Content-type': 'application/x-www-form-urlencoded; charset=UTF-8'
                },
                body: `j_username=${username}&j_password=${password}`
            }
        });
    }

    logout() {
        return this.get('/j_spring_security_logout');
    }

    async isConnected() {
        const response = await this.getCurrentUser();
        return Boolean(response);
    }

    getCurrentUser() {
        return this.get('/api/v1/currentuser')
            .catch(() => null);
    }

    /*
     * @param {ComponentKeys}
     * */
    async getExternalComponents({ forgeName, hubExternalId } = {}) {
        const response = await this.get('/api/components', {
            queryMap: {
                q: `${forgeName}:${hubExternalId}`
            }
        }).catch(() => null);

        if (response) {
            return response.items;
        }

        return [];
    }

    /*
     * @param {ExternalComponent}
     * */
    getComponentVersion({ version: versionUrl } = {}) {
        return this.get(versionUrl);
    }

    /*
     * @param {ComponentVersion}
     * Returns the project versions that contain this component in their BOM
     * */
    async getComponentVersionReferenceProjects(componentVersion) {
        const references = await this.getComponentVersionReferences(componentVersion);
        return Promise.all(references.map(this.getReferenceProjectVersion.bind(this)));
    }

    async getComponentVersionReferences(componentVersion) {
        return this.getListRelation(componentVersion, 'references');
    }

    /*
    * @param {ProjectReference}
    * */
    async getReferenceProjectVersion({ projectName, projectVersionUrl } = {}) {
        const projectVersion = await this.get(projectVersionUrl)
            .catch(() => null);

        if (projectVersion) {
            projectVersion.projectName = projectName;
        }

        return projectVersion;
    }

    /*
     * @param {ExternalComponent}
     * @param {ProjectVersion[]}
     * Returns an array of components, one from each project's BOM that match the external component
     * */
    async getMatchingBOMComponents({ version }, projectVersions) {
        return Promise.all(projectVersions.map(async (projectVersion) => {
            const bomComponents = await this.getProjectVersionComponents(projectVersion);
            return bomComponents.filter(({ componentVersion }) => componentVersion === version);
        })).then(componentArrays => Array.prototype.concat.apply([], componentArrays));
    }

    getComponentPolicyViolations(bomComponent) {
        return this.getListRelation(bomComponent, 'policy-rules');
    }

    /*
     * @param {ProjectVersion}
     * */
    getProjectVersionComponents(projectVersion) {
        return this.getListRelation(projectVersion, 'components');
    }

    async getComponentVulnerabilities(componentVersion) {
        const vulnerabilities = await this.getListRelation(componentVersion, 'vulnerabilities');
        return vulnerabilities.map(vulnerability => {
            let detailsUrl = '';

            if (vulnerability.source === 'NVD') {
                detailsUrl = `https://web.nvd.nist.gov/view/vuln/search-results?query=${vulnerability.vulnerabilityName}&search_type=all&cves=on`;
            } else if (vulnerability.source === 'VULNDB') {
                detailsUrl = `${this.getOrigin()}/#vulnerabilities/id:${vulnerability.vulnerabilityName}/view:overview`;
            }

            return Object.assign(vulnerability, {
                detailsUrl
            });
        });
    }

    getComponentRiskProfile(componentVersion) {
        return this.getRelation(componentVersion, 'risk-profile');
    }

    async getListRelation(model, relationship) {
        const response = await this.getRelation(model, relationship);
        return response ? response.items : [];
    }

    async phoneHome(thirdPartyName, thirdPartyVersion, pluginVersion) {
        const registrationObject = await this.getRegistrationId();
        const { registrationId } = registrationObject;
        const hubVersion = await this.getHubVersion();
        const builder = new PhoneHomeRequestBodyBuilder();
        builder.registrationId = registrationId;
        builder.blackDuckName = 'Hub';
        builder.blackDuckVersion = hubVersion;
        builder.pluginVersion = pluginVersion;
        builder.thirdPartyName = thirdPartyName;
        builder.thirdPartyVersion = thirdPartyVersion;
        const phoneHomeRequestBody = builder.build();
        const phoneHomeClient = new PhoneHomeClient();
        phoneHomeClient.phoneHome(phoneHomeRequestBody);
    }

    async getRegistrationId() {
        return this.get('/api/v1/registrations');
    }

    async getHubVersion() {
        return this.get('/api/v1/current-version');
    }

    getRelation(model, relationship) {
        const hateoasModel = new HateoasModel(model);
        const relationUrl = hateoasModel.getFirstLink(relationship);
        return this.get(relationUrl, {
            queryMap: {
                limit: 10000
            }
        }).catch(() => null);
    }

    /*
     * @param {string} baseUrl
     * @param {object} [queryMap={}]
     * */
    getRequestUrl(baseUrl, queryMap = {}) {
        const origin = this.getOrigin();
        let url = null;

        if (baseUrl.startsWith('/')) {
            // relative path
            url = new URL(origin);
            url.pathname = baseUrl;
        } else {
            url = new URL(baseUrl);
        }

        Object.keys(queryMap).forEach(key => {
            url.searchParams.append(key, queryMap[key]);
        });

        return url;
    }

    /*
     * @param {string} baseUrl
     * @param {object} [queryMap]
     * */
    get(baseUrl, { queryMap, fetchOpts } = {}) {
        const url = this.getRequestUrl(baseUrl, queryMap);
        const opts = Object.assign({
            method: 'GET'
        }, fetchOpts);

        return this.fetch(url, opts);
    }

    post(baseUrl, { queryMap, fetchOpts } = {}) {
        const url = this.getRequestUrl(baseUrl, queryMap);
        const opts = Object.assign({
            method: 'POST'
        }, fetchOpts);

        return this.fetch(url, opts);
    }

    async fetch(url, _opts) {
        const opts = Object.assign({
            credentials: 'include'
        }, _opts);

        if (DEBUG_AJAX) {
            console.log(`Make Hub ${opts.method} request:`, url.toString());
        }

        const response = await fetch(url, opts);
        const body = await response.json().catch(() => null);

        if (!response.ok) {
            if (DEBUG_AJAX) {
                console.warn(`Hub ${opts.method} request failed:`, url.toString());
                console.log('\n');
            }

            throw new Error(body.errorMessage);
        }

        if (DEBUG_AJAX) {
            console.log(`Hub ${opts.method} request completed:`, response.url);
            console.log(`Hub ${opts.method} request status:`, response.status);
            console.log('\n');
        }

        return body;
    }
}

export default Hub;
