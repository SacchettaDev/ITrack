using System.Text.Json.Serialization;

namespace ITrack.api.Services;

public class SerpApiResponse
{
    [JsonPropertyName("jobs_results")]
    public List<SerpApiJobResult> JobsResults { get; set; } = new();
}

public class SerpApiJobResult
{
    [JsonPropertyName("title")]
    public string? Title { get; set; }

    [JsonPropertyName("company_name")]
    public string? CompanyName { get; set; }

    [JsonPropertyName("location")]
    public string? Location { get; set; }

    [JsonPropertyName("related_links")]
    public List<SerpApiRelatedLink>? RelatedLinks { get; set; }

    [JsonPropertyName("detected_extensions")]
    public SerpApiExtensions? DetectedExtensions { get; set; }
}

public class SerpApiRelatedLink
{
    [JsonPropertyName("link")]
    public string? Link { get; set; }
}

public class SerpApiExtensions
{
    [JsonPropertyName("posted_at")]
    public string? PostedAt { get; set; }
}

