import Utils from './utils/utils';
import JSZip from 'jszip';

export class SceneBundle {

    constructor(url, path, parent = null) {
        this.url = url;

        // If a base path was provided, use it for resolving local bundle resources only if
        // the base path is absolute, or this bundle's path is relative
        if (path && (!Utils.isRelativeURL(path) || Utils.isRelativeURL(this.url))) {
            this.path = path;
        }
        else {
            this.path = Utils.pathForURL(this.url);
        }

        this.path_for_parent = path || this.path; // for resolving paths relative to a parent bundle
        this.parent = parent;

        // An ancestor bundle may be a container (e.g. zip file) that needs to resolve relative paths
        // for any scenes it contains, e.g. `root.zip` has a `root.yaml` that includes a `folder/child.yaml`:
        // resources within `child.yaml` must be resolved through the bundle for `root.zip`
        this.container = null;
        if (this.parent) {
            if (this.parent.container) {
                this.container = this.parent.container;
            }
            else if (this.parent.isContainer()) {
                this.container = this.parent;
            }
        }
    }

    load() {
        return Utils.loadResource(this.url);
    }

    // Info for retrieving a specific resource from this bundle
    // url: fully qualified URL to retrieve the content of the resource (e.g. zips will transform this to blob URL)
    // path: original path of the resource within the bundle (for resolving paths up the bundle tree)
    // type: file extension (used for determining bundle type, `yaml` or `zip`)
    resourceFor(url) {
        return {
            url: this.urlFor(url),
            path: this.pathFor(url),
            type: this.typeFor(url)
        };
    }

    urlFor(url) {
        if (Utils.isRelativeURL(url) && this.container) {
            return this.parent.urlFor(this.path_for_parent + url);
        }
        return Utils.addBaseURL(url, this.path);
    }

    pathFor(url) {
        return Utils.pathForURL(url);
    }

    typeFor(url) {
        return Utils.extensionForURL(url);
    }

    isContainer() {
        return false;
    }

}

export class ZipSceneBundle extends SceneBundle {

    constructor(url, path, parent) {
        super(url, path, parent);
        this.zip = null;
        this.files = {};
        this.root = null;
        this.path = '';
    }

    isContainer() {
        return true;
    }

    load() {
        this.zip = new JSZip();

        if (typeof this.url === 'string') {
            return Utils.io(this.url, 60000, 'arraybuffer')
                .then(body => this.zip.loadAsync(body))
                .then(() => this.parseZipFiles())
                .then(() => this.loadRoot())
                .catch(e => Promise.reject(e));
        } else {
            return Promise.resolve(this);
        }
    }

    urlFor(url) {
        if (Utils.isRelativeURL(url)) {
            return this.urlForZipFile(Utils.flattenRelativeURL(url));
        }
        return super.urlFor(url);
    }

    typeFor(url) {
        if (Utils.isRelativeURL(url)) {
            return this.typeForZipFile(url);
        }
        return super.typeFor(url);
    }

    loadRoot() {
        return this.findRoot()
            .then(() => Utils.loadResource(this.urlForZipFile(this.root)));
    }

    findRoot() {
        // There must be a single YAML file at the top level of the zip
        const yamls = Object.keys(this.files)
            .filter(path => this.files[path].depth === 0)
            .filter(path => Utils.extensionForURL(path) === 'yaml');

        if (yamls.length === 1) {
            this.root = yamls[0];
        }

        // No root found
        if (!this.root) {
            let msg = `Could not find root scene for bundle '${this.url}': `;
            msg += `The zip archive's root level must contain a single scene file with the '.yaml' extension. `;
            if (yamls.length > 0) {
                msg += `Found multiple YAML files at the root level: ${yamls.map(r => '\'' + r + '\'' ).join(', ')}.`;
            }
            else {
                msg += `Found NO YAML files at the root level.`;
            }
            return Promise.reject(Error(msg));
        }
        return Promise.resolve();
    }

    parseZipFiles() {
        let paths = [];
        let queue = [];
        this.zip.forEach((path, file) => {
            if (!file.dir) {
                paths.push(path);
                queue.push(file.async('arraybuffer'));
            }
        });

        return Promise.all(queue).then(data => {
            for (let i=0; i < data.length; i++) {
                let path = paths[i];
                let depth = path.split('/').length - 1;
                this.files[path] = {
                    data: data[i],
                    type: Utils.extensionForURL(path),
                    depth
                };
            }
        });
    }

    urlForZipFile(file) {
        if (this.files[file]) {
            if (!this.files[file].url) {
                this.files[file].url = Utils.createObjectURL(new Blob([this.files[file].data]));
            }

            return this.files[file].url;
        }
    }

    typeForZipFile(file) {
        return this.files[file] && this.files[file].type;
    }

}

export function createSceneBundle(url, path, parent, type = null) {
    if (type === 'zip' || (typeof url === 'string' && Utils.extensionForURL(url) === 'zip')) {
        return new ZipSceneBundle(url, path, parent);
    }
    return new SceneBundle(url, path, parent);
}
