import SwiftUI
import UIKit
import WebKit

/// De gepubliceerde Lessenaar in een WKWebView, met Web MIDI via CoreMIDI (polyfill + MIDIBridge).
/// Updates komen van de site zelf: mergen naar main in piano-practice-tracker blijft live, zonder nieuwe build.
final class WebViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate,
    UIGestureRecognizerDelegate {
    static let startURL = URL(string: "https://ricardo0h.github.io/lessenaar/")!
    static let appHost = "ricardo0h.github.io"

    private var webView: WKWebView!
    private let bridge = MIDIBridge()
    private var seq = 0
    private var pageWantsMidi = false
    private var downloadURLs: [ObjectIdentifier: URL] = [:]
    private lazy var offline = makeOfflineView()

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()   // blijvende opslag (IndexedDB) per app
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.applicationNameForUserAgent = "Lessenaar-iOS/" + (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0")
        let content = WKUserContentController()
        content.add(WeakHandler(self), name: "lessenaarMidi")
        if let url = Bundle.main.url(forResource: "midi-polyfill", withExtension: "js"),
           let source = try? String(contentsOf: url, encoding: .utf8) {
            content.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        config.userContentController = content

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never   // de pagina regelt de safe area zelf (viewport-fit=cover)
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 0x16 / 255, green: 0x18 / 255, blue: 0x1A / 255, alpha: 1)
        if #available(iOS 16.4, *) { webView.isInspectable = true }

        let press = UILongPressGestureRecognizer(target: self, action: #selector(openMeting(_:)))
        press.numberOfTouchesRequired = 3
        press.minimumPressDuration = 0.8
        press.cancelsTouchesInView = false
        press.delegate = self
        webView.addGestureRecognizer(press)
        view = webView
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        bridge.onSources = { [weak self] sources in
            Meting.shared.sources = sources
            self?.call("ports", Self.json(sources))
        }
        bridge.onPacket = { [weak self] id, bytes, hostTime in
            guard let self, self.pageWantsMidi else { return }
            self.seq += 1
            Meting.shared.sent(seq: self.seq, source: id, bytes: bytes, hostTime: hostTime)
            let age = String(format: "%.2f", Meting.ageMs(hostTime))
            self.call("packet", "\(id),[\(bytes.map(String.init).joined(separator: ","))],\(self.seq),\(age)")
        }
        webView.load(URLRequest(url: Self.startURL))
    }

    private func call(_ function: String, _ arguments: String) {
        webView.evaluateJavaScript("window.__lessenaarMidi&&window.__lessenaarMidi.\(function)(\(arguments))", completionHandler: nil)
    }

    private static func json<T: Encodable>(_ value: T) -> String {
        (try? String(data: JSONEncoder().encode(value), encoding: .utf8)) ?? "[]"
    }

    fileprivate func received(_ message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "request":
            pageWantsMidi = true
            bridge.start()
        case "ack":
            if let seq = body["seq"] as? Int { Meting.shared.ack(seq: seq, notes: body["notes"] as? Int ?? 0) }
        default:
            break
        }
    }

    // MARK: meetscherm

    @objc private func openMeting(_ gesture: UILongPressGestureRecognizer) {
        guard gesture.state == .began, presentedViewController == nil else { return }
        let host = UIHostingController(rootView: MetingView(close: { [weak self] in self?.dismiss(animated: true) }))
        present(host, animated: true)
    }

    func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }

    // MARK: navigatie

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        pageWantsMidi = false   // nieuwe pagina: wacht tot die zelf om MIDI vraagt
        Meting.shared.pageReloaded()
        offline.removeFromSuperview()
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if action.shouldPerformDownload { decisionHandler(.download); return }
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        let scheme = url.scheme ?? ""
        if ["blob", "data", "about"].contains(scheme) || url.host == Self.appHost {
            decisionHandler(.allow)
        } else if action.targetFrame?.isMainFrame == false {
            decisionHandler(.allow)   // iframes (bijv. een video) blijven in de pagina
        } else {
            UIApplication.shared.open(url)   // links naar buiten (cursus, GitHub) in Safari
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(response.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url {
            if url.host == Self.appHost { webView.load(action.request) } else if url.scheme == "http" || url.scheme == "https" { UIApplication.shared.open(url) }
            // blob:/data: in een nieuw venster niet laden: dan is de app weg en kun je niet terug
        }
        return nil
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showOffline(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { showOffline(error) }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    private func showOffline(_ error: Error) {
        guard (error as NSError).code != NSURLErrorCancelled else { return }
        (offline.viewWithTag(1) as? UILabel)?.text = "Lessenaar laadt niet. Is er wifi?\n\n\(error.localizedDescription)"
        offline.frame = view.bounds
        offline.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        if offline.superview == nil { view.addSubview(offline) }
    }

    private func makeOfflineView() -> UIView {
        let box = UIView()
        box.backgroundColor = .systemBackground
        let label = UILabel()
        label.tag = 1
        label.numberOfLines = 0
        label.textAlignment = .center
        label.font = .preferredFont(forTextStyle: .body)
        let button = UIButton(type: .system, primaryAction: UIAction(title: "Opnieuw") { [weak self] _ in
            self?.offline.removeFromSuperview()
            self?.webView.load(URLRequest(url: Self.startURL))
        })
        button.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        let stack = UIStackView(arrangedSubviews: [label, button])
        stack.axis = .vertical
        stack.spacing = 20
        stack.translatesAutoresizingMaskIntoConstraints = false
        box.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: box.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: box.centerYAnchor),
            stack.widthAnchor.constraint(lessThanOrEqualTo: box.widthAnchor, constant: -48),
        ])
        return box
    }

    // MARK: dialogen (alert/confirm/prompt doen in een WKWebView anders niets)

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        presentOr(alert) { completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Annuleer", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        presentOr(alert) { completionHandler(false) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        alert.addTextField { $0.text = defaultText }
        alert.addAction(UIAlertAction(title: "Annuleer", style: .cancel) { _ in completionHandler(nil) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { [weak alert] _ in completionHandler(alert?.textFields?.first?.text) })
        presentOr(alert) { completionHandler(nil) }
    }

    private func presentOr(_ controller: UIViewController, fallback: () -> Void) {
        if presentedViewController == nil { present(controller, animated: true) } else { fallback() }
    }

    // MARK: downloads (back-up, oefenlog, MIDI-export) → deelblad

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
                  completionHandler: @escaping (URL?) -> Void) {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent(suggestedFilename.isEmpty ? "download" : suggestedFilename)
        downloadURLs[ObjectIdentifier(download)] = url
        completionHandler(url)
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let url = downloadURLs.removeValue(forKey: ObjectIdentifier(download)) else { return }
        let share = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        share.completionWithItemsHandler = { _, _, _, _ in try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        share.popoverPresentationController?.sourceView = view
        share.popoverPresentationController?.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
        share.popoverPresentationController?.permittedArrowDirections = []
        present(share, animated: true)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloadURLs.removeValue(forKey: ObjectIdentifier(download))
    }
}

/// WKUserContentController houdt zijn handler sterk vast; via deze tussenstap lekt de controller niet.
private final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: WebViewController?
    init(_ target: WebViewController) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.received(message)
    }
}

struct WebContainer: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> WebViewController { WebViewController() }
    func updateUIViewController(_ controller: WebViewController, context: Context) {}
}
