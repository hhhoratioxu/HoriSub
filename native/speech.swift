import AVFoundation
import Foundation

struct Voice: Encodable {
    let id: String
    let name: String
    let locale: String
}

struct Request: Decodable {
    let op: String
    let text: String?
    let voice: String?
    let locale: String?
    let rate: Double?
    let volume: Double?
}

final class Completion: NSObject, AVSpeechSynthesizerDelegate {
    var completed = false
    var done = false
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        completed = true
        done = true
    }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        done = true
    }
}

guard let input = readLine(),
      let request = try? JSONDecoder().decode(Request.self, from: Data(input.utf8)) else { exit(2) }
let voices = AVSpeechSynthesisVoice.speechVoices().filter { $0.language.lowercased().hasPrefix("zh-") }
if request.op == "voices" {
    let result = voices.map { Voice(id: $0.identifier, name: $0.name, locale: $0.language) }
    if let output = try? JSONEncoder().encode(result) { print(String(decoding: output, as: UTF8.self)) }
    exit(0)
}
guard request.op == "speak", let text = request.text, !text.isEmpty else { exit(2) }
let available: AVSpeechSynthesisVoice?
if let id = request.voice, !id.isEmpty { available = voices.first { $0.identifier == id } }
else { available = voices.first { $0.language == request.locale } ?? voices.first }
guard let voice = available else { exit(3) }

let synth = AVSpeechSynthesizer()
let completion = Completion()
synth.delegate = completion
let utterance = AVSpeechUtterance(string: String(text.prefix(290)))
utterance.voice = voice
utterance.rate = Float(max(0.30, min(0.63, (request.rate ?? 1) * Double(AVSpeechUtteranceDefaultSpeechRate))))
utterance.volume = Float(max(0, min(1, request.volume ?? 0.85)))
synth.speak(utterance)
let deadline = Date().addingTimeInterval(17)
while !completion.done && Date() < deadline {
    _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
}
if !completion.completed { _ = synth.stopSpeaking(at: .immediate); exit(4) }
print("ok")
