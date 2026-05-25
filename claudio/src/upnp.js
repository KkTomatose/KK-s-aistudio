// src/upnp.js — UPnP / Naim speaker streaming
import { Client } from 'node-ssdp';
import { parseStringPromise } from 'xml2js';

// a. Discover UPnP AVTransport devices
export function discoverDevices(timeoutMs = 5000) {
  return new Promise((resolve) => {
    const client = new Client();
    const devices = [];

    const timer = setTimeout(() => {
      client.stop();
      resolve(devices);
    }, timeoutMs);

    client.on('response', async (headers, code, rinfo) => {
      const location = headers.LOCATION || headers.location;
      if (!location) return;

      try {
        const res = await fetch(location);
        const xml = await res.text();
        const desc = await parseStringPromise(xml);

        const device = desc?.root?.device?.[0];
        if (!device) return;

        const friendlyName = device.friendlyName?.[0] || 'Unknown';
        const serviceList = device.serviceList?.[0]?.service || [];
        let controlUrl = '';

        for (const svc of serviceList) {
          if (svc.serviceType?.[0]?.includes('AVTransport')) {
            controlUrl = svc.controlURL?.[0] || '';
            break;
          }
        }

        if (controlUrl && !devices.find(d => d.controlUrl === controlUrl)) {
          // Make relative URLs absolute
          const base = new URL(location);
          if (!controlUrl.startsWith('http')) {
            controlUrl = new URL(controlUrl, base.origin + base.pathname).toString();
          }
          devices.push({
            friendlyName,
            location,
            controlUrl,
            type: 'AVTransport'
          });
        }
      } catch {}
    });

    client.search('urn:schemas-upnp-org:service:AVTransport:1');
  });
}

// b. Send SOAP command to control URL
async function soapAction(controlUrl, actionName, body) {
  const soapBody = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>${body}</s:Body>
</s:Envelope>`;

  const res = await fetch(controlUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset="utf-8"',
      'SOAPAction': `"urn:schemas-upnp-org:service:AVTransport:1#${actionName}"`
    },
    body: soapBody
  });

  return res.ok;
}

// c. Play audio URL on device
export async function playOnDevice(device, audioUrl) {
  try {
    const setUri = await soapAction(device.controlUrl, 'SetAVTransportURI',
      `<u:SetAVTransportURI xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
        <InstanceID>0</InstanceID>
        <CurrentURI>${audioUrl}</CurrentURI>
        <CurrentURIMetaData></CurrentURIMetaData>
      </u:SetAVTransportURI>`);

    if (!setUri) return false;

    const play = await soapAction(device.controlUrl, 'Play',
      `<u:Play xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
        <InstanceID>0</InstanceID>
        <Speed>1</Speed>
      </u:Play>`);

    return play;
  } catch (e) {
    console.warn('[upnp] playOnDevice failed:', e.message);
    return false;
  }
}

// d. Stop device
export async function stopDevice(device) {
  try {
    return await soapAction(device.controlUrl, 'Stop',
      `<u:Stop xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
        <InstanceID>0</InstanceID>
      </u:Stop>`);
  } catch {
    return false;
  }
}

// e. Find Naim device
export async function getNaimDevice() {
  try {
    const devices = await discoverDevices();
    return devices.find(d =>
      /naim|mu-so|muso/i.test(d.friendlyName)
    ) || null;
  } catch {
    return null;
  }
}

// TEST: node src/upnp.js
if (process.argv[1]?.endsWith('/src/upnp.js') || process.argv[1]?.endsWith('\\src\\upnp.js')) {
  console.log('[upnp] Self-test: discovering UPnP devices...');
  discoverDevices().then(devices => {
    console.log('[upnp] Found', devices.length, 'device(s):');
    devices.forEach(d => console.log(' -', d.friendlyName, d.controlUrl));
  });
}
